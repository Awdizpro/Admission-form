
// server/src/controllers/admission.controller.js

import sharp from "sharp";
import { uploadBuffer } from "../services/storage.service.js";
import Admission from "../models/Admission.js";
import { generateAdmissionPDF } from "../services/pdf.service.js"; // returns { buffer, url, ... }
import {
  sendAdmissionEmails,
  sendCounselorMail,
  transporter,
  sendOtpEmail, // 🔹 NEW: email OTP
} from "../services/email.service.js";
import {
  appendAdmissionRow,
  setAdmissionStatus,
  updateAdmissionRow,
} from "../services/sheets.service.js";
import { sendOtpSms } from "../services/sms.service.js"; // 🔹 NEW: SMS OTP
import { generateOtp, hashOtp, verifyOtp } from "../services/otp.service.js"; // 🔹 NEW: OTP utils

// normalize any pdf-service return into a URL string
const asUrl = (x) =>
  typeof x === "string"
    ? x
    : x?.url || x?.secure_url || "";


// in-memory pending OTP store
// pendingId -> { payload, mobile, email, mobileOtpHash, emailOtpHash, mobileVerified, emailVerified, createdAt, expiresAt }
const pending = new Map();

// counselor → student edit window (single-use)
// admissionId -> { sections, fields, createdAt }
const editPending = new Map();

const toBool = (v, d = true) => {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return d;
};

// Helper: is PDF?

function pickCounselorEmailsByKey(key) {
  const k = String(key || "").trim().toLowerCase() === "c2" ? "c2" : "c1";

  const envKey = k === "c2" ? "COUNSELOR2_EMAILS" : "COUNSELOR1_EMAILS";
  const raw = String(process.env[envKey] || "");

  const list = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  return { counselorKey: k, list };
}

// function getServerBaseUrl() {
//   // local me backend port wali url do
//   return String(process.env.SERVER_BASE_URL || "http://localhost:5002").replace(/\/+$/, "");
// }

function getServerBaseUrl() {
  const base =
    process.env.SERVER_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    "http://localhost:5002";

  return String(base).replace(/\/+$/, "");
}


const isPdf = (file) =>
  !!file &&
  (file.mimetype === "application/pdf" ||
    /\.pdf$/i.test(file.originalname || ""));

// Helper: is image?
const isImage = (file) => !!file && /^image\//i.test(file.mimetype || "");

// Helper: make a preview image URL for PDFs uploaded as resource_type:"image"
// pg_1 => first page, f_jpg => render as jpg
const pdfFirstPageJpgUrl = (pdfUrl) => {
  if (!pdfUrl || typeof pdfUrl !== "string") return "";
  return pdfUrl
    .replace("/upload/", "/upload/pg_1,f_jpg/")
    .replace(/\.pdf(\?.*)?$/i, ".jpg$1");
};

// ✅ Unified uploader for photo/pan/aadhaar
// - If PDF: upload as resource_type:"image" + format:"pdf" (served via /image/upload/...pdf)
// - If image: upload as resource_type:"image" + format:"jpg"
async function uploadStudentDoc({ file, folder, publicIdPrefix }) {
  if (!file) return { url: "", kind: "", previewUrl: "" };

  // PDF → upload as image-type PDF
  if (isPdf(file)) {
    const up = await uploadBuffer({
      buffer: file.buffer,
      folder,
      publicId: `${publicIdPrefix}-${Date.now()}`,
      resource_type: "image",
      extra: { format: "pdf" },
    });

    const url = up?.secure_url || "";
    return {
      url,
      kind: "pdf",
      previewUrl: pdfFirstPageJpgUrl(url),
    };
  }

  // Image → upload as image/jpg
  if (isImage(file)) {
    const up = await uploadBuffer({
      buffer: file.buffer,
      folder,
      publicId: `${publicIdPrefix}-${Date.now()}`,
      resource_type: "image",
      extra: { format: "jpg" },
    });

    const url = up?.secure_url || "";
    return {
      url,
      kind: "image",
      previewUrl: url,
    };
  }

  // Unsupported type
  return { url: "", kind: "unsupported", previewUrl: "" };
}

// Convert uploaded image -> compact JPEG data URL (SKIPS PDFs)
async function compressToJpegDataUrl(file, maxW = 600, maxH = 600, q = 80) {
  if (!file) return null;

  // ✅ Only images should be processed by sharp
  if (!/^image\//i.test(file.mimetype || "")) return null;

  try {
    let buf = await sharp(file.buffer)
      .resize({
        width: maxW,
        height: maxH,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: q })
      .toBuffer();

    if (buf.length > 2 * 1024 * 1024) {
      buf = await sharp(buf).jpeg({ quality: 60 }).toBuffer();
    }

    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch (e) {
    console.error("compressToJpegDataUrl failed:", e?.message);
    return null;
  }
}

const tryPickDataUrl = (v) =>
  typeof v === "string" && v.startsWith("data:image") ? v : null;

/* ==================== INIT ADMISSION ==================== */
 async function initAdmission(req, res) {
  try {
    const body = JSON.parse(req.body.payload || "{}");

    // counselorKey resolve
    const counselorKey =
      String(
        req.query?.c ||
          body?.counselorKey ||
          body?.meta?.counselorKey ||
          body?.course?.counselorKey ||
          "c1"
      )
        .trim()
        .toLowerCase() === "c2"
        ? "c2"
        : "c1";

    if (
      !body?.personal?.name ||
      !body?.personal?.studentMobile ||
      !body?.personal?.email ||
      (!body?.course?.name && !body?.course?.trainingOnlyCourse) ||
      body?.termsAccepted !== true
    ) {
      return res.status(400).json({
        message:
          "Please complete all required fields and accept Terms & Conditions.",
      });
    }

    // ===============================
    // ✅ UPLOAD FILES (PDF/IMAGE/MIX)
    // ===============================
    let photoUrl, panUrl, aadhaarUrl;
    let photoKind, panKind, aadhaarKind;
    let photoPreviewUrl, panPreviewUrl, aadhaarPreviewUrl;

    try {
      if (req.files?.photo?.[0]) {
        const r = await uploadStudentDoc({
          file: req.files.photo[0],
          folder: "awdiz/admissions/photos",
          publicIdPrefix: "photo",
        });
        photoUrl = r.url;
        photoKind = r.kind;
        photoPreviewUrl = r.previewUrl;
      }
    } catch (e) {
      console.log("photo upload skipped:", e?.message);
    }

    try {
      if (req.files?.pan?.[0]) {
        const r = await uploadStudentDoc({
          file: req.files.pan[0],
          folder: "awdiz/admissions/pan",
          publicIdPrefix: "pan",
        });
        panUrl = r.url;
        panKind = r.kind;
        panPreviewUrl = r.previewUrl;
      }
    } catch (e) {
      console.log("pan upload skipped:", e?.message);
    }

    try {
      if (req.files?.aadhaar?.[0]) {
        const r = await uploadStudentDoc({
          file: req.files.aadhaar[0],
          folder: "awdiz/admissions/aadhaar",
          publicIdPrefix: "aadhaar",
        });
        aadhaarUrl = r.url;
        aadhaarKind = r.kind;
        aadhaarPreviewUrl = r.previewUrl;
      }
    } catch (e) {
      console.log("aadhaar upload skipped:", e?.message);
    }

    // ===============================
    // ✅ DATA URLs FOR PDF EMBED
    // - only for images
    // - if user uploads PDFs for pan/aadhaar, these become null (safe)
    // ===============================
    const photoDataUrl = await compressToJpegDataUrl(req.files?.photo?.[0]);
    const panDataUrl = await compressToJpegDataUrl(req.files?.pan?.[0]);
    const aadhaarDataUrl = await compressToJpegDataUrl(req.files?.aadhaar?.[0]);

    /* ---------- Signatures (data URLs only; NO student->parent fallback) ---------- */
    const studentSignDataUrl =
      tryPickDataUrl(req.body?.studentSignDataUrl) ||
      tryPickDataUrl(body?.files?.studentSign) ||
      tryPickDataUrl(body?.signatures?.student?.signDataUrl) ||
      null;

    const parentSignDataUrl =
      tryPickDataUrl(req.body?.parentSignDataUrl) ||
      tryPickDataUrl(body?.files?.parentSign) ||
      tryPickDataUrl(body?.signatures?.parent?.signDataUrl) ||
      null;

    // Quick debug
    const _studLen = (studentSignDataUrl || "").length;
    const _parLen = (parentSignDataUrl || "").length;
    console.log("[SIG] student(len):", _studLen, " parent(len):", _parLen);

    // STRICT: Parent/Guardian sign is mandatory (no fallback)
    if (!_parLen) {
      return res.status(400).json({
        message:
          "Parent/Guardian signature is required (data URL missing or too large).",
        hint: "Ensure field name is 'parentSignDataUrl' and increase multer fieldSize to 10MB.",
      });
    }

    const payload = {
      ...body,
      personal: {
        ...body.personal,
        name: String(body.personal.name || "").trim(),
        studentMobile: String(body.personal.studentMobile || "").trim(),
        email: String(body.personal.email || "").trim(),
      },
      course: { ...body.course, enrolled: toBool(body?.course?.enrolled, true) },
      uploads: {
        photoUrl,
        panUrl,
        aadhaarUrl,

        // ✅ NEW meta
        photoKind, // "image" | "pdf"
        panKind,
        aadhaarKind,

        // ✅ NEW previews
        photoPreviewUrl,
        panPreviewUrl,
        aadhaarPreviewUrl,

        // ✅ For embedding in generated admission PDF
        photoDataUrl,
        panDataUrl,
        aadhaarDataUrl,
      },
      signatures: {
        ...body.signatures,
        student: {
          ...(body.signatures?.student || {}),
          signDataUrl:
            body.signatures?.student?.signDataUrl || studentSignDataUrl || null,
          signUrl:
            body.signatures?.student?.signUrl || studentSignDataUrl || null,
        },
        parent: {
          ...(body.signatures?.parent || {}),
          signDataUrl:
            body.signatures?.parent?.signDataUrl || parentSignDataUrl || null,
          signUrl:
            body.signatures?.parent?.signUrl || parentSignDataUrl || null,
        },
      },
      tc: {
        accepted: true,
        version: body.tcVersion || "",
        text: body.tcText || "",
        type: body.course.trainingOnly ? "training-only" : "job-guarantee",
      },
      meta: {
        planType: body.course.trainingOnly ? "training" : "job",
        counselorKey,
      },
    };

    /* ==================== 2-OTP GENERATION ==================== */
    const mobileOtpRaw = process.env.OTP_ALWAYS || generateOtp(6);
    const emailOtpRaw = process.env.OTP_ALWAYS || generateOtp(6);

    const mobileOtpHash = hashOtp(mobileOtpRaw);
    const emailOtpHash = hashOtp(emailOtpRaw);

    const pendingId = `p_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;

    const now = Date.now();
    const ttlMs = 15 * 60 * 1000; // 15 minutes

    pending.set(pendingId, {
      payload,
      mobile: payload.personal.studentMobile,
      email: payload.personal.email,
      mobileOtpHash,
      emailOtpHash,
      mobileVerified: false,
      emailVerified: false,
      createdAt: now,
      expiresAt: now + ttlMs,
    });

    // 📨 SEND MOBILE OTP (SMS)
    try {
      await sendOtpSms(payload.personal.studentMobile, mobileOtpRaw);
    } catch (err) {
      console.error("sendOtpSms failed:", err?.message || err);
    }

    // 📨 SEND EMAIL OTP
    try {
      await sendOtpEmail({
        to: payload.personal.email,
        name: payload.personal.name,
        otp: emailOtpRaw,
      });
    } catch (err) {
      console.error("sendOtpEmail failed:", err?.message || err);
    }

    // DEV log
    if (String(process.env.SMS_DUMMY || "true") === "true") {
      console.log("🧪 DEV Mobile OTP:", mobileOtpRaw);
      console.log("🧪 DEV Email  OTP:", emailOtpRaw);
    }

    return res.status(200).json({
      pendingId,
      message: "Mobile & Email OTP sent.",
    });
  } catch (e) {
    console.error("initAdmission failed:", e);
    return res.status(500).json({ message: "Server error" });
  }
}



/* ==================== VERIFY (2-STEP OTP) ==================== */
async function dummyVerifyAdmissionOtp(req, res) {
  try {
    const { pendingId, otp } = req.body || {};

    if (!pendingId || !otp) {
      return res
        .status(400)
        .json({ message: "pendingId and otp are required" });
    }

    const item = pending.get(pendingId);
    if (!item) {
      return res
        .status(400)
        .json({ message: "Session expired or invalid pendingId" });
    }

    // expiry check
    if (item.expiresAt && Date.now() > item.expiresAt) {
      pending.delete(pendingId);
      return res.status(400).json({ message: "OTP session expired" });
    }

    const devMaster = process.env.DEV_MASTER_OTP || "000000";

    /* --------- STEP 1: MOBILE OTP --------- */
    if (!item.mobileVerified) {
      const ok =
        otp === devMaster ||
        (item.mobileOtpHash && verifyOtp(otp, item.mobileOtpHash));

      if (!ok) {
        return res.status(400).json({ message: "Invalid Mobile OTP" });
      }

      item.mobileVerified = true;
      pending.set(pendingId, item);

      return res.status(200).json({
        message: "Mobile OTP verified. Please enter Email OTP.",
        step: "mobile-verified",
        next: "email",
      });
    }

    /* --------- STEP 2: EMAIL OTP --------- */
    if (!item.emailVerified) {
      const ok =
        otp === devMaster ||
        (item.emailOtpHash && verifyOtp(otp, item.emailOtpHash));

      if (!ok) {
        return res.status(400).json({ message: "Invalid Email OTP" });
      }

      item.emailVerified = true;
      pending.set(pendingId, item);

      // ✅ Now BOTH verified → FINALIZE ADMISSION (same as old dummyVerify logic)
      const p = { ...item.payload, status: "pending" };

      // PDFs (buffer + url)
  
      const counselorPdf = await generateAdmissionPDF({ ...p, status: "pending" });

      const pendingCounselorUrl = asUrl(counselorPdf);

      if (!pendingCounselorUrl) {
        throw new Error("PDF service did not return URL for pending PDFs.");
      }

      // Save PENDING in DB
      const saved = await Admission.create({
        ...p,
        pdf: { pendingCounselorUrl },
        education: (p.education || []).map((ed) => ({
          qualification: ed.qualification || "",
          school: ed.school || "",
          year: ed.year || "",
          percentage: ed.percentage || "",
        })),
      });

      // ✅ GOOGLE SHEET: append PENDING row (AdmissionID = saved._id)
      try {
        const courseName = p?.course?.name || "Admissions";
        await appendAdmissionRow(courseName, {
          ...p,
          pdfUrl: pendingCounselorUrl,
          admissionId: String(saved._id),
          status: "Pending",
          counselorKey: p?.meta?.counselorKey, // ✅ NEW
        });
      } catch (err) {
        console.error("❌ Google Sheet (pending append) failed:", err?.message);
      }

      // // Mail student (attachment + link)
      await sendAdmissionEmails({
        studentEmail: p.personal.email,
        // pdfBuffer: studentPdf.buffer,
        // pdfFileName: `Awdiz-Admission-${saved._id}.pdf`,
        // pdfUrl: pendingStudentUrl,
        payload: p,
      });

      // Mail counselor (attachment + review link button)
      await sendCounselorMail({
        payload: { ...p, _id: saved._id },
        counselorPdfUrl: pendingCounselorUrl,
        pdfBuffer: counselorPdf.buffer,
        pdfFileName: `Awdiz-Admission-Pending-${saved._id}.pdf`,
      });

      return res.status(200).json({
  message: "Admission Submitted – Pending Approval",
  id: saved._id,
  step: "completed",
});
    }

    // If both already verified:
    return res.status(200).json({
      message: "Already verified.",
      step: "completed",
    });
  } catch (e) {
    console.error("dummyVerifyAdmissionOtp failed:", e);
    return res.status(500).json({ message: "Server error" });
  }
}

/* ==================== APPROVE (ADMIN/COUNSELOR) ==================== */

/**
 * NEW FLOW:
 * Counselor reviews admission and submits to Admin (with fees amount + mode).
 * - Updates admission.meta.feeAmount / meta.feeMode (no PDF changes)
 * - Tries to update Google Sheet row (if row exists)
 * - Sends email ONLY to admin(s) with PDF attachment + Approve button link
 */
async function submitToAdmin(req, res) {
  try {
    const { id } = req.params;

    // 1️⃣ READ + VALIDATE FEES (ONLY ONCE)
    const feeAmountRaw = req.body?.feeAmount;
    const feeModeRaw = req.body?.feeMode;
    const totalFeesRaw = req.body?.totalFees;
    const pendingFeesRaw = req.body?.pendingFees;
    const instalmentPlanRaw = req.body?.instalmentPlan;
    const instalmentCountRaw = req.body?.instalmentCount;
    const isBajajEMIRaw = req.body?.isBajajEMI;
    const isCheckRaw = req.body?.isCheck;
    const additionalFeesRaw = req.body?.additionalFees;
    const additionalFeeModeRaw = req.body?.additionalFeeMode;
    
    // Read multiple instalment dates and amounts
    const instalmentDate1 = req.body?.instalmentDate1;
    const instalmentDate2 = req.body?.instalmentDate2;
    const instalmentDate3 = req.body?.instalmentDate3;
    const instalmentAmount1 = Number(req.body?.instalmentAmount1) || 0;
    const instalmentAmount2 = Number(req.body?.instalmentAmount2) || 0;
    const instalmentAmount3 = Number(req.body?.instalmentAmount3) || 0;

    const feeAmount = Number(feeAmountRaw);
    const feeMode = String(feeModeRaw || "").trim().toLowerCase();
    const totalFees = Number(totalFeesRaw) || 0;
    const pendingFees = Number(pendingFeesRaw) || 0;
    const instalmentPlan = String(instalmentPlanRaw || "").trim();
    const instalmentCount = Number(instalmentCountRaw) || 0;
    const isBajajEMI = isBajajEMIRaw === 'true' || isBajajEMIRaw === true;
    const isCheck = isCheckRaw === 'true' || isCheckRaw === true;
    const additionalFees = additionalFeesRaw ? Number(additionalFeesRaw) : 0;
    const additionalFeeMode = additionalFeeModeRaw ? String(additionalFeeModeRaw || "").trim().toLowerCase() : "";

    if (!Number.isFinite(feeAmount) || feeAmount < 0) {
      return res.status(400).send("Invalid fee amount");
    }

    if (!["cash", "online", "cheque"].includes(feeMode)) {
      return res.status(400).send("Invalid payment mode");
    }

    // Build instalment dates array
    const instalmentDates = [];
    const instalmentAmounts = [];
    if (instalmentPlan.startsWith('instalment_')) {
      if (instalmentDate1) {
        instalmentDates.push(new Date(instalmentDate1));
        instalmentAmounts.push(instalmentAmount1);
      }
      if (instalmentDate2) {
        instalmentDates.push(new Date(instalmentDate2));
        instalmentAmounts.push(instalmentAmount2);
      }
      if (instalmentDate3) {
        instalmentDates.push(new Date(instalmentDate3));
        instalmentAmounts.push(instalmentAmount3);
      }
      
      // Validate that required dates are provided
      if (instalmentDates.length !== instalmentCount) {
        return res.status(400).send(`Please provide all ${instalmentCount} instalment dates`);
      }
    }

    // 2️⃣ FETCH DOCUMENT
    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).send("Admission not found");

    // 3️⃣ SAVE FEES IN DB
    doc.fees = doc.fees || {};
    doc.fees.amount = feeAmount;
    doc.fees.paymentMode = feeMode;
    doc.fees.totalFees = totalFees;
    doc.fees.pendingFees = pendingFees;
    doc.fees.instalmentPlan = instalmentPlan;
    doc.fees.instalmentCount = instalmentCount;
    doc.fees.isBajajEMI = isBajajEMI;
    doc.fees.isCheck = isCheck;
    doc.fees.instalmentDates = instalmentDates;
    doc.fees.instalmentAmounts = instalmentAmounts;
    doc.fees.additionalFees = additionalFees || 0;
    doc.fees.additionalFeeMode = additionalFeeMode || "";
    // Keep legacy fields for compatibility
    doc.fees.nextInstalmentDate = instalmentDates[0] || null;
    doc.fees.perInstalmentAmount = instalmentAmounts[0] || 0;
    
    doc.workflow = doc.workflow || {};
    doc.workflow.counselorSubmittedToAdminAt = new Date();

    await doc.save();

    // update row in sheets (if supported)
    try {
      const courseName = doc?.course?.name || "General";
      await updateAdmissionRow(courseName, doc);
    } catch (err) {
      console.log("❌ Google Sheet (update on submitToAdmin) failed:", err.message);
    }

    // Generate a fresh PENDING pdf buffer for admin attachment (pdf content unchanged)
    let pdfBuffer = null;
    let pdfUrl = "";
    try {
      const pdfRes = await generateAdmissionPDF(doc.toObject());
      pdfBuffer = pdfRes?.buffer || null;
      pdfUrl =
  asUrl(pdfRes) ||
  doc?.pdf?.pendingCounselorUrl ||
  doc?.pdf?.pendingStudentUrl ||
  "";

    } catch (err) {
      console.log("❌ PDF generation failed (submitToAdmin):", err.message);
      pdfUrl = doc?.pdfUrl || "";
    }

    // admin emails
    const adminEmails = String(process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    if (!adminEmails.length) {
      return res
        .status(500)
        .send("ADMIN_EMAILS missing in env. Please set ADMIN_EMAILS.");
    }

    const BASE_URL =
      process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "http://localhost:5002";

    const reviewUrl = `${BASE_URL}/api/admissions/${doc._id}/admin-review`;

    // Build fee details HTML with instalment schedule
    let feeDetailsHtml = `
      <p style="margin:0 0 8px"><b>Total Fees:</b> ₹${totalFees}</p>
      <p style="margin:0 0 8px"><b>Paid Fees:</b> ₹${feeAmount}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>Payment Mode:</b> ${feeMode.toUpperCase()}</p>
      ${additionalFees > 0 ? `<p style="margin:0 0 8px"><b>Split Fees:</b> ₹${additionalFees}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>Split Payment Mode:</b> ${additionalFeeMode.toUpperCase()}</p>` : ''}
      <p style="margin:0 0 8px"><b>Total Pending Fees:</b> ₹${pendingFees}</p>
    `;

    // Add No Cost EMI message for split fees
    if (additionalFeeMode === 'no_cost_emi') {
      feeDetailsHtml += `
        <div style="margin:12px 0; padding:12px; background:#dcfce7; border-radius:4px; border-left:4px solid #22c55e;">
          <p style="margin:0; color:#15803d; font-weight:600;">🏦 No Cost EMI Process Successfully Done</p>
        </div>
      `;
    }
    
    // Add instalment schedule if applicable
    if (instalmentPlan.startsWith('instalment_') && instalmentCount > 0) {
      feeDetailsHtml += `
        <div style="margin:12px 0; padding:12px; background:#f0fdf4; border-radius:4px; border-left:4px solid #16a34a;">
          <p style="margin:0 0 8px; font-weight:600; color:#15803d;">📅 Instalment Schedule:</p>
          <p style="margin:0 0 8px; color:#166534;">
            After the ₹${feeAmount} registration fee, the remaining ₹${pendingFees} will be paid in ${instalmentCount} installment${instalmentCount > 1 ? 's' : ''}.
          </p>
      `;
      
      for (let i = 0; i < instalmentCount; i++) {
        const date = instalmentDates[i] ? new Date(instalmentDates[i]).toLocaleDateString("en-IN", { day: 'numeric', month: 'long' }) : 'TBD';
        const amount = instalmentAmounts[i] || 0;
        feeDetailsHtml += `
          <p style="margin:4px 0; color:#166534; padding-left:12px;">
            <b>Instalment ${i + 1}:</b> ₹${amount} on ${date} 
          </p>
        `;
      }
      
      feeDetailsHtml += `</div>`;
    }

    // Add Bajaj EMI notice if applicable
    if (isBajajEMI) {
      feeDetailsHtml += `
        <p style="margin:8px 0; padding:8px; background:#fef3c7; border-radius:4px; color:#92400e;">
          <b>⚠️ No Cost EMI PROCESS:</b> Student has selected Bajaj EMI option. Please process this separately.
        </p>
      `;
    }
    
    // Add Cheque Payment notice if applicable
    if (isCheck) {
      feeDetailsHtml += `
        <p style="margin:8px 0; padding:8px; background:#f0f9ff; border-radius:4px; color:#0369a1;">
          <b>📝 CHEQUE PAYMENT:</b> Student has selected Cheque payment option. Please process this separately.
        </p>
      `;
    }

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2 style="margin:0 0 8px">Admission Pending — Admin Approval Required</h2>
        <p style="margin:0 0 8px"><b>Student:</b> ${doc?.personal?.name || "-"}</p>
        <p style="margin:0 0 8px"><b>Course:</b> ${doc?.course?.name || "-"}</p>
        <p style="margin:0 0 8px"><b>Center:</b> ${doc?.center?.placeOfAdmission || "-"}</p>

        <div style="background:#f3f4f6; padding:12px; border-radius:8px; margin:12px 0;">
          <h3 style="margin:0 0 8px; color:#374151;">💰 Fee Details</h3>
          ${feeDetailsHtml}
        </div>

        <p style="margin:12px 0 0">
          <a href="${reviewUrl}"
   style="display:inline-block;background:#2563eb;color:#fff;
          padding:10px 14px;border-radius:10px;
          text-decoration:none;font-weight:700">
  🔍 Review Admission
</a>

        </p>

        ${pdfUrl ? `<p style="margin:10px 0 0">PDF Link: <a href="${pdfUrl}">Open PDF</a></p>` : ``}
      </div>
    `;

    const mail = {
      to: adminEmails,
      subject: `Pending Admission for Approval: ${doc?.personal?.name || "Student"}`,
      html,
      attachments: [],
    };

    if (pdfBuffer) {
      mail.attachments.push({
        filename: `admission-${doc._id}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      });
    }

    await transporter.sendMail(mail);

    // Build success message with fee details and instalment schedule
    let successMessage = `
      <p><b>Total Fees:</b> ₹${totalFees}</p>
      <p><b>Paid Fees:</b> ₹${feeAmount}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>Payment Mode:</b> ${feeMode.toUpperCase()}</p>
      ${additionalFees > 0 ? `<p><b>Split Fees:</b> ₹${additionalFees}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>Split Payment Mode:</b> ${additionalFeeMode.toUpperCase()}</p>` : ''}
      <p><b>Total Pending Fees:</b> ₹${pendingFees}</p>
    `;

    // Add No Cost EMI message for split fees
    if (additionalFeeMode === 'no_cost_emi') {
      successMessage += `
        <div style="margin-top:12px; padding:10px; background:#dcfce7; border-radius:4px; border-left:4px solid #22c55e;">
          <p style="margin:0; color:#15803d; font-weight:600;">🏦 No Cost EMI Process Successfully Done</p>
        </div>
      `;
    }
    
    // Add instalment schedule
    if (instalmentPlan.startsWith('instalment_') && instalmentCount > 0) {
      successMessage += `
        <div style="margin-top:12px; padding:10px; background:#f0fdf4; border-radius:4px;">
          <p style="margin:0 0 8px; color:#15803d; font-weight:600;">📅 Instalment Schedule:</p>
          <p style="margin:0 0 8px; color:#166534;">
            After the ₹${feeAmount} registration fee, the remaining ₹${pendingFees} will be paid in ${instalmentCount} installment${instalmentCount > 1 ? 's' : ''}.
          </p>
      `;
      
      for (let i = 0; i < instalmentCount; i++) {
        const date = instalmentDates[i] ? new Date(instalmentDates[i]).toLocaleDateString("en-IN", { day: 'numeric', month: 'long' }) : 'TBD';
        const amount = instalmentAmounts[i] || 0;
        successMessage += `
          <p style="margin:4px 0; color:#166534; padding-left:12px;">
            <b>Instalment ${i + 1}:</b> ₹${amount} on ${date}
          </p>
        `;
      }
      
      successMessage += `</div>`;
    }

    if (isBajajEMI) {
      successMessage += `<p style="color:#92400e; margin-top:12px;"><b>⚠️ No Cost EMI PROCESS SELECTED</b></p>`;
    }
    
    if (isCheck) {
      successMessage += `<p style="color:#0369a1; margin-top:12px;"><b>📝 CHEQUE PAYMENT SELECTED</b></p>`;
    }

    // simple success page for counselor
    return res.send(`
      <html>
        <head><meta charset="utf-8"/><title>Submitted</title></head>
        <body style="font-family:Arial,sans-serif;padding:24px">
          <h2>✅ Submitted to Admin</h2>
          <div style="background:#f3f4f6; padding:16px; border-radius:8px; margin:16px 0;">
            <h3 style="margin-top:0;">💰 Fee Details</h3>
            ${successMessage}
          </div>
          <p>Admin has received the email with approval button.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("submitToAdmin error:", err);
    return res.status(500).send("Submit to Admin failed.");
  }
}

async function approveAdmission(req, res) {
  if (req.method === "GET") {
    return res
      .status(403)
      .send("<h3>Approval is only allowed from Admin Review Page.</h3>");
  }

  try {
    const { id } = req.params;

    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).send("<h2>Admission not found</h2>");

    /* =========================
       1️⃣ ADMIN FEES OVERRIDE
       ========================= */
    doc.fees = doc.fees || {};

    if (req.body?.feeAmount !== undefined) {
      const amt = Number(req.body.feeAmount);
      if (!Number.isFinite(amt) || amt < 0) {
        return res.status(400).send("Invalid fee amount");
      }
      doc.fees.amount = amt;
    }

    if (req.body?.feeMode) {
      const mode = String(req.body.feeMode).toLowerCase();
      if (!["cash", "online", "instalment", "bajaj_emi", "cheque"].includes(mode)) {
        return res.status(400).send("Invalid payment mode");
      }
      doc.fees.paymentMode = mode;
    }

    /* =========================
       2️⃣ VALIDATE counselorKey (🔥 IMPORTANT FIX)
       ========================= */
    const counselorKey = String(doc?.meta?.counselorKey || "")
      .trim()
      .toLowerCase();

    if (!["c1", "c2"].includes(counselorKey)) {
      console.error("❌ counselorKey missing/invalid:", counselorKey, doc._id);
      return res
        .status(400)
        .send("Counselor key missing. Cannot approve admission.");
    }

    /* =========================
       3️⃣ MARK APPROVED (DB)
       ========================= */
    doc.status = "approved";
    doc.workflow = doc.workflow || {};
    doc.workflow.adminApprovedAt = new Date();

    /* =========================
       4️⃣ GENERATE APPROVED PDF
       ========================= */
    const approvedPdf = await generateAdmissionPDF({
      ...doc.toObject(),
      status: "approved",
    });

    const approvedUrl = asUrl(approvedPdf);
    if (!approvedUrl) {
      throw new Error("Approved PDF URL missing");
    }

    doc.pdf = { ...(doc.pdf || {}), approvedUrl };

    /* =========================
       5️⃣ SAVE DB (ONCE)
       ========================= */
    await doc.save();

    /* =========================
       6️⃣ UPDATE GOOGLE SHEETS (🔥 SAFE)
       ========================= */
    try {
      // ✅ FULL ROW UPDATE (fees + mode + pdf)
      await updateAdmissionRow(doc.course.name, {
        ...doc.toObject(),
        counselorKey, // 🔥 explicitly pass
      });

      // ✅ STATUS + APPROVED PDF
      await setAdmissionStatus(
        doc.center?.placeOfAdmission || "",
        doc.course?.name || "Admissions",
        String(doc._id),
        "approved",
        {
          approvedPdfUrl: approvedUrl,
          counselorKey, // 🔥 NO fallback
        }
      );
    } catch (err) {
      console.error("❌ Google Sheet update failed:", err.message);
    }

    /* =========================
       7️⃣ STUDENT APPROVAL MAIL
       ========================= */
    // await sendAdmissionEmails({
    //   studentEmail: doc.personal.email,
    //   pdfBuffer: approvedPdf.buffer,
    //   pdfFileName: `Awdiz-Admission-Approved-${doc._id}.pdf`,
    //   pdfUrl: approvedUrl,
    //   payload: doc.toObject(),
    // });

    // helpers
const splitEmails = (v) =>
  String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const pickFromEmail = () => process.env.FROM_EMAIL || process.env.SMTP_USER;

// inside approveAdmission AFTER approvedPdf is ready (approvedPdf.buffer) and approvedUrl is ready

/* =========================
   7️⃣ SEND APPROVED EMAILS (Student + Admin + Counselor)
   ========================= */
try {
  const fromEmail = pickFromEmail();
  if (!fromEmail) {
    console.warn("⚠️ FROM_EMAIL/SMTP_USER missing. Email may fail.");
  }

  const studentEmail = doc?.personal?.email;

  // admin recipients
  const adminEmails = splitEmails(process.env.ADMIN_EMAILS);

  // counselor recipients (same counselor who submitted it to admin)
  const { list: counselorEmails } = pickCounselorEmailsByKey(doc?.meta?.counselorKey);

  const studentName = doc?.personal?.name || "Student";
  const courseName = doc?.course?.name || "Course";
  const centerName = doc?.center?.placeOfAdmission || "-";
  const feeAmount = doc?.fees?.amount ?? "";
  const feeMode = doc?.fees?.paymentMode || "";
  const totalFees = doc?.fees?.totalFees ?? 0;
  const pendingFees = doc?.fees?.pendingFees ?? 0;
  const additionalFees = doc?.fees?.additionalFees ?? 0;
  const additionalFeeMode = doc?.fees?.additionalFeeMode || "";
  const isBajajEMI = doc?.fees?.isBajajEMI || feeMode === "bajaj_emi";
  const isCheck = doc?.fees?.isCheck || feeMode === "cheque";
  const instalmentPlan = doc?.fees?.instalmentPlan || "";
  const instalmentCount = doc?.fees?.instalmentCount || 0;
  const instalmentDates = doc?.fees?.instalmentDates || [];
  const instalmentAmounts = doc?.fees?.instalmentAmounts || [];

  // Build fee details section with instalment schedule
  let feeDetailsHtml = `
    <div style="background:#f0fdf4; border:1px solid #86efac; border-radius:8px; padding:16px; margin:16px 0;">
      <h3 style="margin:0 0 12px; color:#15803d;">💰 Fee Details</h3>
      <p style="margin:0 0 6px"><b>Total Fees:</b> ₹${totalFees}</p>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px 0; font-size:14px;">
        <tr>
          <td style="padding:0; font-weight:bold;">Paid Fees:</td>
          <td style="padding:0 8px 0 4px;">₹${feeAmount}</td>
          <td style="padding:0; font-weight:bold;">Payment Mode:</td>
          <td style="padding:0 0 0 4px; font-weight:bold;">${feeMode.toUpperCase()}</td>
        </tr>
        ${(additionalFees > 0 || additionalFeeMode) ? `
        <tr>
          <td style="padding:0;"></td>
          <td style="padding:0 8px 0 4px;">₹${additionalFees || 0}</td>
          <td style="padding:0; font-weight:bold;">Payment Mode:</td>
          <td style="padding:0 0 0 4px; font-weight:bold;">${additionalFeeMode.toUpperCase()}</td>
        </tr>
        ` : ''}
        ${additionalFeeMode === 'no_cost_emi' ? `
        <tr>
          <td colspan="4" style="padding:8px 0 0 0;">
            <div style="padding:8px; background:#dcfce7; border-radius:4px; border-left:4px solid #22c55e;">
              <p style="margin:0; color:#15803d; font-weight:600;">🏦 No Cost EMI Process Successfully Done</p>
            </div>
          </td>
        </tr>
        ` : ''}
      </table>
      <p style="margin:0 0 6px"><b>Total Pending Fees:</b> ₹${pendingFees}</p>
  `;

  // Add instalment schedule if applicable
  if (instalmentPlan.startsWith('instalment_') && instalmentCount > 0) {
    feeDetailsHtml += `
      <div style="margin-top:12px; padding-top:12px; border-top:1px solid #86efac;">
        <p style="margin:0 0 12px; font-weight:600; color:#15803d;">📅 Instalment Schedule:</p>
        <p style="margin:0 0 12px; color:#166534; line-height:1.6;">
          After receiving the ₹${feeAmount} registration fees, it was discussed and mutually agreed that the student would pay the ₹${pendingFees} remaining fees in ${instalmentCount} installment${instalmentCount > 1 ? 's' : ''}.
        </p>
    `;
    
    for (let i = 0; i < instalmentCount; i++) {
      const date = instalmentDates[i] ? new Date(instalmentDates[i]).toLocaleDateString("en-IN", { day: 'numeric', month: 'long' }) : 'TBD';
      const amount = instalmentAmounts[i] || 0;
      feeDetailsHtml += `
        <p style="margin:4px 0; color:#166534; padding-left:12px;">
          <b>Instalment ${i + 1}:</b> ₹${amount} on ${date}
        </p>
      `;
    }
    
    feeDetailsHtml += `</div>`;
  }

  feeDetailsHtml += `</div>`;

  // Special message for Bajaj EMI
  let bajajEMIHtml = "";
  if (isBajajEMI) {
    bajajEMIHtml = `
      <div style="background:#fef3c7; border:1px solid #fbbf24; border-radius:8px; padding:16px; margin:16px 0;">
        <h3 style="margin:0 0 12px; color:#92400e;">🏦 No Cost EMI Process</h3>
        <p style="margin:0 0 12px; color:#78350f; line-height:1.6;">
          The student has opted for the no-cost EMI option for fee payment.<br/>
          The remaining balance of ₹${pendingFees}/- can be conveniently converted into No-cost EMIs, subject to submission of required financial documents.
        </p>
        <p style="margin:0 0 8px; color:#92400e; font-weight:600;">Below is the list of financial documents required:</p>
        <ul style="margin:0; padding-left:20px; color:#78350f;">
          <li>Aadhar card</li>
          <li>PAN Card</li>
          <li>Last 180 days' bank statement</li>
          <li>1 Live photograph</li>
          <li>Work proof (Salary Slip/Offer Letter)</li>
        </ul>
        <p style="margin:12px 0 0; color:#78350f;">
          I trust this information is clear and helpful.
        </p>
      </div>
    `;
  }
  
  // Special message for Cheque Payment
  let checkHtml = "";
  if (isCheck) {
    checkHtml = `
      <div style="background:#f0f9ff; border:1px solid #38bdf8; border-radius:8px; padding:16px; margin:16px 0;">
        <h3 style="margin:0 0 12px; color:#0369a1;">📝 Cheque Payment</h3>
        <p style="margin:0 0 12px; color:#0c4a6e; line-height:1.6;">
          The student has opted for Cheque payment option for fee payment.<br/>
          Please collect the cheque from the student and process it accordingly.
        </p>
        <p style="margin:12px 0 0; color:#0c4a6e;">
          I trust this information is clear and helpful.
        </p>
      </div>
    `;
  }

  const commonHtml = `
    <div style="font-family:system-ui,Arial,sans-serif;line-height:1.6">
      <h2 style="margin:0 0 10px;color:#16a34a">✅ Admission Approved</h2>

      <p style="margin:0 0 6px"><b>Student:</b> ${studentName}</p>
      <p style="margin:0 0 6px"><b>Course:</b> ${courseName}</p>
      <p style="margin:0 0 6px"><b>Center:</b> ${centerName}</p>

      ${feeDetailsHtml}
      ${bajajEMIHtml}
      ${checkHtml}

      ${approvedUrl ? `<p style="margin:10px 0 0">PDF Link: <a href="${approvedUrl}" target="_blank">Open Approved PDF</a></p>` : ``}

      <p style="margin-top:14px;font-size:12px;color:#6b7280">
        This email includes the approved admission PDF as an attachment.
      </p>
    </div>
  `.trim();

const attachment = {
    filename: `Awdiz-Admission-Approved-${studentName}.pdf`,
    content: approvedPdf.buffer,              // ✅ MUST be Buffer
    contentType: "application/pdf",
  };

  // 1) Student mail
  if (studentEmail) {
    await transporter.sendMail({
      from: `"Awdiz Admissions" <${fromEmail}>`,
      to: studentEmail,
      subject: `✅ Admission Approved – ${studentName}`,
      html: commonHtml,
      attachments: [attachment],
    });
    console.log("📨 Approved mail sent to STUDENT →", studentEmail);
  } else {
    console.warn("⚠️ Student email missing; skipping student approved mail.");
  }

  // 2) Admin mail
  if (adminEmails.length) {
    await transporter.sendMail({
      from: `"Awdiz Admissions" <${fromEmail}>`,
      to: adminEmails,
      subject: `✅ Admission Approved (Admin Copy) – ${studentName} (${courseName})`,
      html: commonHtml,
      attachments: [attachment],
    });
    console.log("📨 Approved mail sent to ADMIN →", adminEmails);
  } else {
    console.warn("⚠️ ADMIN_EMAILS empty; skipping admin approved mail.");
  }

  // 3) Counselor mail
  if (counselorEmails.length) {
    await transporter.sendMail({
      from: `"Awdiz Admissions" <${fromEmail}>`,
      to: counselorEmails,
      subject: `✅ Admission Approved (Counselor Copy) – ${studentName} (${courseName})`,
      html: commonHtml,
      attachments: [attachment],
    });
    console.log("📨 Approved mail sent to COUNSELOR →", counselorEmails);
  } else {
    console.warn("⚠️ Counselor email list empty; skipping counselor approved mail.");
  }
} catch (mailErr) {
  console.error("❌ Approved email sending failed:", mailErr);
  // NOTE: approval already done, so we don't crash approval response
}

    
    return res.status(200).send("Admission Approved Successfully ✅");
  } catch (err) {
    console.error("approveAdmission failed:", err);
    return res.status(500).send("<h2>Server error</h2>");
  }
}



/* ==================== COUNSELOR REVIEW PAGE (HTML) ==================== */
async function reviewAdmissionPage(req, res) {
  try {
    const { id } = req.params;
    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).send("<h2>Admission not found</h2>");

    const p = doc.toObject();

    // 🔴 LAST REQUESTED FIELDS (jo counselor ne ❌ mark kiye the)
    const editReq = p.editRequest || {};
    const flaggedFields = Array.isArray(editReq.fields) ? editReq.fields : [];
    const lastNotes = editReq.notes || "";

    const pdfUrl =
      p?.pdf?.pendingCounselorUrl ||
      p?.pdf?.pendingStudentUrl ||
      p?.pdf?.approvedUrl ||
      p?.pdfUrl ||
      "";

      const feeAmount =
  p?.fees?.amount !== undefined && p?.fees?.amount !== null
    ? p.fees.amount
    : "";

const feeMode =
  typeof p?.fees?.paymentMode === "string"
    ? p.fees.paymentMode
    : "";

const additionalFees = p?.fees?.additionalFees ?? 0;
const additionalFeeMode = p?.fees?.additionalFeeMode || "";


    const eduRows =
      (p.education || []).length > 0
        ? (p.education || [])
            .map(
              (ed, idx) => `
            <tr>
              <td>${idx + 1}</td>
              <td>${ed.qualification || "-"}</td>
              <td>${ed.school || "-"}</td>
              <td>${ed.year || "-"}</td>
              <td>${ed.percentage || "-"}</td>
            </tr>`
            )
            .join("")
        : `<tr><td colspan="5" style="padding:6px 8px;font-size:13px;color:#6b7280;">No education details filled.</td></tr>`;

    const jobType = p?.course?.trainingOnly
      ? "No Job Guarantee – Training only"
      : "Job Guarantee Training";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Awdiz Admission Review – ${p.personal?.name || ""}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:#e5e7eb;
      margin:0;
      padding:24px 12px;
    }
    .page {
      max-width: 1080px;
      margin:0 auto;
      background:#f9fafb;
      border-radius:12px;
      border:1px solid #e5e7eb;
      padding:20px;
    }
    .header {
      display:flex;
      justify-content:space-between;
      align-items:center;
      margin-bottom:14px;
    }
    .title {
      font-size:20px;
      font-weight:600;
      margin:0;
    }
    .subtitle {
      font-size:13px;
      color:#6b7280;
      margin-top:4px;
    }
    .pdf-pane {
      border:1px solid #e5e7eb;
      border-radius:10px;
      overflow:hidden;
      background:#111827;
      margin-bottom:16px;
    }
    .pdf-pane-header {
      display:flex;
      justify-content:space-between;
      align-items:center;
      padding:10px 14px;
      background:#111827;
      color:#f9fafb;
      font-size:13px;
    }
    .pdf-frame {
      width:100%;
      height:480px;
      border:0;
      background:#111827;
    }
    .btn-inline {
      display:inline-flex;
      align-items:center;
      gap:6px;
      font-size:13px;
      padding:6px 10px;
      border-radius:999px;
      border:1px solid #4b5563;
      color:#e5e7eb;
      text-decoration:none;
      background:transparent;
    }
    .btn-inline span.icon { font-size:15px; }

    form#review-form {
      margin-top:4px;
    }
    .section-card {
      background:#ffffff;
      border-radius:10px;
      border:1px solid #e5e7eb;
      padding:14px 16px;
      margin-top:10px;
    }
    .sec-header {
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      margin-bottom:8px;
      gap:8px;
    }
    .sec-title {
      font-size:14px;
      font-weight:600;
      margin:0;
    }
    .sec-badges {
      display:flex;
      gap:8px;
      font-size:12px;
    }
    .badge {
      display:inline-flex;
      align-items:center;
      gap:4px;
      padding:2px 8px;
      border-radius:999px;
      border:1px solid #d1d5db;
      background:#f9fafb;
      color:#374151;
    }
    .badge input {
      margin:0;
    }
    .grid-2 {
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:8px 16px;
      font-size:13px;
    }
    .field-label {
      font-size:12px;
      text-transform:uppercase;
      letter-spacing:.04em;
      color:#6b7280;
      margin-bottom:2px;
    }
    .field-value {
      font-size:13px;
      color:#111827;
      padding:4px 6px;
      border-radius:6px;
      background:#f9fafb;
      border:1px dashed #e5e7eb;
      min-height:26px;
    }
    .field-flagged {
      border-color:#ef4444 !important;
      background:#fef2f2 !important;
      color:#b91c1c;
    }
    table.edu {
      width:100%;
      border-collapse:collapse;
      font-size:12px;
      margin-top:4px;
    }
    .edu th, .edu td {
      border:1px solid #e5e7eb;
      padding:4px 6px;
      text-align:left;
    }
    .edu th {
      background:#f3f4f6;
      font-weight:600;
    }
    .notes-box {
      width:100%;
      min-height:70px;
      border-radius:8px;
      border:1px solid #d1d5db;
      padding:8px 10px;
      font-size:13px;
      resize:vertical;
    }
    .actions-row {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      margin-top:14px;
      align-items:center;
    }
    .btn-primary {
      border:none;
      border-radius:999px;
      padding:10px 18px;
      font-size:14px;
      font-weight:600;
      cursor:pointer;
      display:inline-flex;
      align-items:center;
      gap:8px;
      background:#f97316;
      color:#ffffff;
    }
    .btn-primary:hover { background:#ea580c; }
    .btn-success {
      border:none;
      border-radius:999px;
      padding:10px 18px;
      font-size:14px;
      font-weight:600;
      cursor:pointer;
      display:inline-flex;
      align-items:center;
      gap:8px;
      background:#16a34a;
      color:#ffffff;
      text-decoration:none;
    }
    .btn-success:hover { background:#15803d; }
    .btn-ghost {
      border-radius:999px;
      padding:8px 14px;
      font-size:13px;
      display:inline-flex;
      align-items:center;
      gap:8px;
      border:1px solid #e5e7eb;
      background:#ffffff;
      color:#111827;
      text-decoration:none;
      cursor:pointer;
    }
    .helper {
      margin-top:6px;
      font-size:12px;
      color:#6b7280;
    }

    /* ==== NEW for per-field flags ==== */
    .field-row {
      display:flex;
      align-items:flex-start;
      gap:8px;
      margin-bottom:8px;
    }
    .field-main {
      flex:1 1 auto;
    }
    .field-flags {
      display:flex;
      flex-direction:row;
      gap:4px;
      align-items:center;
      font-size:11px;
      white-space:nowrap;
    }
    .mini-badge {
      display:inline-flex;
      align-items:center;
      gap:2px;
      padding:1px 6px;
      border-radius:999px;
      border:1px solid #d1d5db;
      background:#f9fafb;
      color:#374151;
    }
    .mini-badge input {
      margin:0;
    }
    .hidden-section-checkbox {
      display:none;
    }

    @media (max-width:768px){
      .grid-2 { grid-template-columns:1fr; }
      .pdf-frame { height:380px; }
    }
  
      .fee-row{
        display:flex;
        gap:10px;
        align-items:center;
        flex-wrap:wrap;
      }
      .fee-input{
        flex:1;
        min-width:160px;
        padding:10px 12px;
        border:1px solid #e5e7eb;
        border-radius:10px;
        outline:none;
      }
      .fee-select{
        min-width:140px;
        padding:10px 12px;
        border:1px solid #e5e7eb;
        border-radius:10px;
        outline:none;
        background:#fff;
      }
      .submit-admin-form{ margin:0; }
      /* live review states */
.field-ok {
  border-color: #93c5fd;      /* blue */
  background: #eff6ff;
  color: #1e3a8a;
}

/* loading overlay */
#loading-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 9999;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.3);
}
#loading-overlay .loader-box {
  background: #fff;
  padding: 20px 24px;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.15);
  display: flex;
  align-items: center;
  gap: 12px;
}
#loading-overlay .spinner {
  width: 24px;
  height: 24px;
  border: 3px solid #e5e7eb;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ==================== RESPONSIVE STYLES ==================== */
@media (max-width: 768px) {
  body {
    padding: 12px 8px;
  }
  .page {
    padding: 12px;
    border-radius: 8px;
  }
  .header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .title {
    font-size: 18px;
  }
  .pdf-frame {
    height: 300px;
  }
  .grid-2 {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .field-row {
    flex-direction: column;
    gap: 6px;
  }
  .field-flags {
    justify-content: flex-end;
  }
  .sec-header {
    flex-direction: column;
    gap: 8px;
  }
  .sec-badges {
    flex-wrap: wrap;
  }
  .actions-row {
    flex-direction: column;
    align-items: stretch;
  }
  .btn-primary, .btn-success, .btn-ghost {
    width: 100%;
    justify-content: center;
  }
  .fee-row {
    flex-direction: column;
    align-items: stretch;
  }
  .fee-input, .fee-select {
    width: 100%;
    min-width: auto;
  }
  table.edu {
    font-size: 11px;
  }
  .edu th, .edu td {
    padding: 3px 4px;
  }
  .pdf-pane-header {
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
  #totalRemainingDiv {
    margin-top: 12px;
  }
  #totalRemainingDiv span:last-child {
    font-size: 18px;
  }
}

@media (max-width: 480px) {
  .title {
    font-size: 16px;
  }
  .subtitle {
    font-size: 12px;
  }
  .pdf-frame {
    height: 250px;
  }
  .section-card {
    padding: 10px 12px;
  }
  .sec-title {
    font-size: 13px;
  }
  .field-label {
    font-size: 11px;
  }
  .field-value {
    font-size: 12px;
    padding: 3px 5px;
  }
  .btn-primary, .btn-success {
    padding: 12px 16px;
    font-size: 13px;
  }
  .badge {
    font-size: 11px;
    padding: 2px 6px;
  }
  .mini-badge {
    font-size: 10px;
    padding: 1px 4px;
  }
  .notes-box {
    min-height: 60px;
    font-size: 12px;
  }
}

</style>
</head>
<body>
  <!-- loading overlay -->
  <div id="loading-overlay">
    <div class="loader-box">
      <div class="spinner"></div>
      <span style="font-weight:600;color:#374151;">Submitting to Admin…</span>
    </div>
  </div>

  <div class="page">
    <div class="header">
      <div>
        <h1 class="title">Awdiz Admission Review</h1>
        <p class="subtitle">
          Student: <b>${p.personal?.name || "-"}</b> &middot; Course: <b>${p.course?.name || "-"}</b>
        </p>
      </div>
    </div>

    <!-- PDF preview -->
    <div class="pdf-pane">
      <div class="pdf-pane-header">
        <div>Pending Admission PDF</div>
        <div>
          ${
            pdfUrl
              ? `<a class="btn-inline" href="${pdfUrl}" target="_blank"><span class="icon">📄</span><span>Open PDF in new tab</span></a>`
              : `<span style="font-size:12px;color:#9ca3af;">No PDF URL found</span>`
          }
        </div>
      </div>
      ${
        pdfUrl
          ? `<iframe
  class="pdf-frame"
  src="${pdfUrl}#toolbar=0&navpanes=0"
></iframe>`
          : `<div style="padding:18px;font-size:13px;color:#9ca3af;">PDF not available.</div>`
      }
    </div>

    <!-- REVIEW FORM -->
    <form id="review-form" method="POST" action="/api/admissions/${doc._id}/request-edit">

      <!-- PERSONAL (field-wise flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Personal Information</p>
        </div>

        <!-- hidden master checkbox for backend -->
        <input
          type="checkbox"
          name="sections"
          value="personal"
          data-section-master="personal"
          class="hidden-section-checkbox"
        />

        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Full Name</div>
              <div data-field="pf_fullName"
  class="field-value${flaggedFields.includes("pf_fullName") ? " field-flagged" : ""}">
${p.personal?.salutation || ""} ${p.personal?.name || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_fullName" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_fullName" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Father / Guardian Name</div>
              <div data-field="pf_guardian" class="field-value${
                flaggedFields.includes("pf_guardian") ? " field-flagged" : ""
              }">${p.personal?.fatherOrGuardianName || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_guardian" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_guardian" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Address</div>
              <div data-field="pf_address" class="field-value${
                flaggedFields.includes("pf_address") ? " field-flagged" : ""
              }">${p.personal?.address || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_address" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_address" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Student Mobile</div>
              <div data-field="pf_studentMobile" class="field-value${
                flaggedFields.includes("pf_studentMobile") ? " field-flagged" : ""
              }">${p.personal?.studentMobile || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_studentMobile" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_studentMobile" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">WhatsApp Mobile</div>
              <div data-field="pf_whatsapp" class="field-value${
                flaggedFields.includes("pf_whatsapp") ? " field-flagged" : ""
              }">${p.personal?.whatsappMobile || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_whatsapp" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_whatsapp" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Parent Mobile</div>
              <div data-field="pf_parentMobile" class="field-value${
                flaggedFields.includes("pf_parentMobile") ? " field-flagged" : ""
              }">${p.personal?.parentMobile || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_parentMobile" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_parentMobile" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Email</div>
              <div data-field="pf_email" class="field-value${
                flaggedFields.includes("pf_email") ? " field-flagged" : ""
              }">${p.personal?.email || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_email" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_email" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- COURSE (with field-level flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Course Details</p>
          <!-- hidden master checkbox for backend -->
          <input
            type="checkbox"
            name="sections"
            value="course"
            data-section-master="course"
            class="hidden-section-checkbox"
          />
        </div>
        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Course Name</div>
              <div data-field="cr_name" class="field-value${flaggedFields.includes("cr_name") ? " field-flagged" : ""}">${p.course?.name || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="cr_name" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="cr_name" value="fix" data-section="course" /> ❌</label>
            </div>
          </div>
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Reference</div>
              <div data-field="cr_reference" class="field-value${flaggedFields.includes("cr_reference") ? " field-flagged" : ""}">${p.course?.reference || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="cr_reference" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="cr_reference" value="fix" data-section="course" /> ❌</label>
            </div>
          </div>
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Plan Type</div>
              <div data-field="cr_planType" class="field-value${flaggedFields.includes("cr_planType") ? " field-flagged" : ""}">${jobType}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="cr_planType" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="cr_planType" value="fix" data-section="course" /> ❌</label>
            </div>
          </div>
        </div>
      </div>

      <!-- EDUCATION (same) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Educational Details</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
            <label class="badge"><input type="checkbox" name="sections" value="education" /> ❌ Needs correction</label>
          </div>
        </div>
        <table class="edu">
          <thead>
            <tr>
              <th>#</th>
              <th>Qualification</th>
              <th>School / College</th>
              <th>Year</th>
              <th>% Marks</th>
            </tr>
          </thead>
          <tbody>${eduRows}</tbody>
        </table>
      </div>

      <!-- IDS (with field-level flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">ID Details</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
            <label class="badge"><input type="checkbox" name="sections" value="ids" /> ❌ Needs correction</label>
          </div>
        </div>
        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">PAN Number</div>
              <div data-field="id_pan" class="field-value${flaggedFields.includes("id_pan") ? " field-flagged" : ""}">${p.ids?.pan || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="id_pan" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="id_pan" value="fix" data-section="ids" /> ❌</label>
            </div>
          </div>
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Aadhaar / Driving</div>
              <div data-field="id_aadhaar" class="field-value${flaggedFields.includes("id_aadhaar") ? " field-flagged" : ""}">${p.ids?.aadhaarOrDriving || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="id_aadhaar" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="id_aadhaar" value="fix" data-section="ids" /> ❌</label>
            </div>
          </div>
        </div>
      </div>

      <!-- UPLOADS (field-wise flags, master = "uploads") -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Uploads</p>
        </div>

        <input
          type="checkbox"
          name="sections"
          value="uploads"
          data-section-master="uploads"
          class="hidden-section-checkbox"
        />

        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Passport Photo</div>
              <div data-field="up_photo" class="field-value${
  flaggedFields.includes("up_photo") ? " field-flagged" : ""
}">
  ${
    p.uploads?.photoUrl
      ? `<img 
           src="${p.uploads.photoUrl}" 
           alt="Passport Photo"
           style="max-width:120px;max-height:120px;border-radius:8px;border:1px solid #e5e7eb"
         />`
      : "-"
  }
</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="up_photo" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="up_photo" value="fix" data-section="uploads" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">PAN</div>
              <div data-field="up_pan" class="field-value${
  flaggedFields.includes("up_pan") ? " field-flagged" : ""
}">
  ${
    p.uploads?.panUrl
      ? (/\.(png|jpg|jpeg|webp)$/i.test(p.uploads.panUrl)
          ? `<img src="${p.uploads.panUrl}" alt="PAN" style="max-width:140px;max-height:140px;border-radius:8px;border:1px solid #e5e7eb" />`
          : `<a href="${p.uploads.panUrl}" target="_blank">📄 View PAN Document</a>`)
      : "-"
  }
</div>

            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="up_pan" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="up_pan" value="fix" data-section="uploads" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Aadhaar</div>
              <div data-field="up_aadhaar" class="field-value${
  flaggedFields.includes("up_aadhaar") ? " field-flagged" : ""
}">
  ${
    p.uploads?.aadhaarUrl
      ? (/\.(png|jpg|jpeg|webp)$/i.test(p.uploads.aadhaarUrl)
          ? `<img src="${p.uploads.aadhaarUrl}" alt="Aadhaar" style="max-width:140px;max-height:140px;border-radius:8px;border:1px solid #e5e7eb" />`
          : `<a href="${p.uploads.aadhaarUrl}" target="_blank">📄 View Aadhaar Document</a>`)
      : "-"
  }
</div>

            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="up_aadhaar" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="up_aadhaar" value="fix" data-section="uploads" />
                ❌
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- CENTER (with field-level flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Center Details</p>
          <!-- hidden master checkbox for backend -->
          <input
            type="checkbox"
            name="sections"
            value="center"
            data-section-master="center"
            class="hidden-section-checkbox"
          />
        </div>
        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Place of Admission</div>
              <div data-field="center_place" class="field-value${flaggedFields.includes("center_place") ? " field-flagged" : ""}">${p.center?.placeOfAdmission || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="center_place" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="center_place" value="fix" data-section="center" /> ❌</label>
            </div>
          </div>
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Mode</div>
              <div data-field="center_mode" class="field-value${flaggedFields.includes("center_mode") ? " field-flagged" : ""}">${p.center?.mode || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="center_mode" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="center_mode" value="fix" data-section="center" /> ❌</label>
            </div>
          </div>
        </div>
      </div>

      <!-- SIGNATURES (field-wise flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Signatures</p>
        </div>

        <input
          type="checkbox"
          name="sections"
          value="signatures"
          data-section-master="signatures"
          class="hidden-section-checkbox"
        />

        <div class="field-row">
          <div class="field-main">
            <div class="field-label">Student Name</div>
            <div data-field="sg_student_name" class="field-value${flaggedFields.includes("sg_student_name") ? " field-flagged" : ""}">${p.signatures?.student?.fullName || "-"}</div>
          </div>
          <div class="field-flags">
            <label class="mini-badge"><input type="radio" name="sg_student_name" value="ok" checked /> ✅</label>
            <label class="mini-badge"><input type="radio" name="sg_student_name" value="fix" data-section="signatures" /> ❌</label>
          </div>
        </div>

        <div class="field-row">
          <div class="field-main">
            <div class="field-label">Student Signature</div>
            <div data-field="sg_student_sign" class="field-value${flaggedFields.includes("sg_student_sign") ? " field-flagged" : ""}">
              ${(p.signatures?.student?.signUrl || p.signatures?.student?.signDataUrl)
                ? `<img src="${p.signatures?.student?.signUrl || p.signatures?.student?.signDataUrl}" alt="Student Signature" style="height:42px;max-width:220px;object-fit:contain;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:4px" />`
                : `<span style="font-size:12px;color:#6b7280;">No signature</span>`
              }
            </div>
          </div>
          <div class="field-flags">
            <label class="mini-badge"><input type="radio" name="sg_student_sign" value="ok" checked /> ✅</label>
            <label class="mini-badge"><input type="radio" name="sg_student_sign" value="fix" data-section="signatures" /> ❌</label>
          </div>
        </div>

        <div class="field-row">
          <div class="field-main">
            <div class="field-label">Parent / Guardian Name</div>
            <div data-field="sg_parent_name" class="field-value${flaggedFields.includes("sg_parent_name") ? " field-flagged" : ""}">${p.signatures?.parent?.fullName || "-"}</div>
          </div>
          <div class="field-flags">
            <label class="mini-badge"><input type="radio" name="sg_parent_name" value="ok" checked /> ✅</label>
            <label class="mini-badge"><input type="radio" name="sg_parent_name" value="fix" data-section="signatures" /> ❌</label>
          </div>
        </div>

        <div class="field-row">
          <div class="field-main">
            <div class="field-label">Parent / Guardian Signature</div>
            <div data-field="sg_parent_sign" class="field-value${flaggedFields.includes("sg_parent_sign") ? " field-flagged" : ""}">
              ${(p.signatures?.parent?.signUrl || p.signatures?.parent?.signDataUrl)
                ? `<img src="${p.signatures?.parent?.signUrl || p.signatures?.parent?.signDataUrl}" alt="Parent Signature" style="height:42px;max-width:220px;object-fit:contain;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:4px" />`
                : `<span style="font-size:12px;color:#6b7280;">No signature</span>`
              }
            </div>
          </div>
          <div class="field-flags">
            <label class="mini-badge"><input type="radio" name="sg_parent_sign" value="ok" checked /> ✅</label>
            <label class="mini-badge"><input type="radio" name="sg_parent_sign" value="fix" data-section="signatures" /> ❌</label>
          </div>
        </div>

        </div>
      </div>

      <!-- NOTES -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Notes to Student (optional)</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" name="sections" value="other" /> ❌ Other issue</label>
          </div>
        </div>
        <textarea name="notes" class="notes-box" placeholder="Example: Please correct spelling of your name and upload a clearer Aadhaar scan.">${lastNotes}</textarea>
        <p class="helper">Jo sections yahan ❌ select karenge, unhi ko baad me student ke form me editable rakha jaa sakta hai.</p>
      </div>

      <!-- FEE SECTION -->
      <div class="section-card" style="background:#f0f9ff; border-color:#bae6fd;">
        <div class="sec-header">
          <p class="sec-title" style="color:#0369a1;">💰 Fee Details</p>
        </div>
        
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:12px;">
          <!-- Total Fees -->
          <div>
            <label style="font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.04em;">Total Fees (₹)</label>
            <input
              type="number"
              id="totalFees"
              name="totalFees"
              min="0"
              step="1"
              placeholder="Enter total course fees"
              value="${p?.fees?.totalFees || ''}"
              class="fee-input"
              style="width:100%; margin-top:4px;"
              onchange="calculatePendingFees()"
            />
          </div>
          
          <!-- Paid Fees -->
          <div>
            <label style="font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.04em;">Paid Fees (₹)</label>
            <input
              type="number"
              id="paidFees"
              name="feeAmount"
              min="0"
              step="1"
              placeholder="Student Registration Fees"
              value="${feeAmount !== "" ? feeAmount : ""}"
              class="fee-input"
              style="width:100%; margin-top:4px;"
              required
              onchange="calculatePendingFees()"
            />
          </div>
          
          <!-- Payment Mode - Moved next to Paid Fees -->
          <div>
            <label style="font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.04em;">Payment Mode</label>
            <select id="feeMode" name="feeMode" class="fee-select" style="width:100%; margin-top:4px;" required>
              <option value="" disabled ${!feeMode ? "selected" : ""}>Select Payment Mode</option>
              <option value="cash" ${feeMode === "cash" ? "selected" : ""}>Cash</option>
              <option value="online" ${feeMode === "online" ? "selected" : ""}>Online</option>
              <option value="cheque" ${feeMode === "cheque" ? "selected" : ""}>Cheque</option>
            </select>
          </div>
        </div>
        
        <!-- Split Fees Checkbox -->
        <div style="margin-bottom:12px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:14px; color:#374151;">
            <input type="checkbox" id="splitFeesCheckbox" onchange="toggleSplitFees()" ${p?.fees?.additionalFees > 0 ? 'checked' : ''} />
            <span>Split Fees details</span>
          </label>
        </div>
        
        <!-- Split Fees (Optional) - Only shown when checkbox is checked -->
        <div id="splitFeesSection" style="display:${p?.fees?.additionalFees > 0 ? 'grid' : 'none'}; grid-template-columns:repeat(2, 1fr); gap:12px; margin-bottom:12px;">
          <!-- Split Fees Amount -->
          <div>
            <label style="font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.04em;">Split Fees (₹) <span style="color:#9ca3af; font-weight:normal;">(Optional)</span></label>
            <input
              type="number"
              id="additionalFees"
              name="additionalFees"
              min="0"
              step="1"
              placeholder="Enter split fees if any"
              value="${p?.fees?.additionalFees || ''}"
              class="fee-input"
              style="width:100%; margin-top:4px;"
              onchange="calculatePendingFees()"
            />
          </div>
          
          <!-- Split Fees Payment Mode -->
          <div>
            <label style="font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.04em;">Split fees payment mode <span style="color:#9ca3af; font-weight:normal;">(Optional)</span></label>
            <select id="additionalFeeMode" name="additionalFeeMode" class="fee-select" style="width:100%; margin-top:4px;" onchange="handleAdditionalFeeModeChange()">
              <option value="" ${!p?.fees?.additionalFeeMode ? "selected" : ""}>Select Payment Mode</option>
              <option value="cash" ${p?.fees?.additionalFeeMode === "cash" ? "selected" : ""}>Cash</option>
              <option value="online" ${p?.fees?.additionalFeeMode === "online" ? "selected" : ""}>Online</option>
              <option value="cheque" ${p?.fees?.additionalFeeMode === "cheque" ? "selected" : ""}>Cheque</option>
              <option value="no_cost_emi" ${p?.fees?.additionalFeeMode === "no_cost_emi" ? "selected" : ""}>No Cost EMI</option>
            </select>
          </div>
        </div>
        
        <!-- Total Pending Fees - Auto Calculated -->
        <div style="background:#fff; padding:12px; border-radius:8px; border:2px solid #0ea5e9; margin-bottom:12px;">
          <label style="font-size:12px; color:#0284c7; text-transform:uppercase; letter-spacing:0.04em; font-weight:600;">Total Pending Fees (Auto-calculated)</label>
          <div style="font-size:20px; font-weight:700; color:#0369a1; margin-top:4px;">
            ₹<span id="pendingFeesDisplay">${(p?.fees?.totalFees || 0) - (feeAmount !== "" ? feeAmount : 0)}</span>
          </div>
          <input type="hidden" id="pendingFees" name="pendingFees" value="${(p?.fees?.totalFees || 0) - (feeAmount !== "" ? feeAmount : 0)}" />
        </div>
        
        <!-- Select Instalment Plan (Separate Dropdown) -->
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.04em;">Select Instalment / EMI Option</label>
          <select id="instalmentPlan" name="instalmentPlan" class="fee-select" style="width:100%; margin-top:4px;" onchange="handleInstalmentChange()">
            <option value="" ${!p?.fees?.instalmentPlan ? "selected" : ""}>None (Full Payment)</option>
            <option value="instalment_1" ${p?.fees?.instalmentPlan === 'instalment_1' ? 'selected' : ''}>Instalment 1</option>
            <option value="instalment_2" ${p?.fees?.instalmentPlan === 'instalment_2' ? 'selected' : ''}>Instalment 2</option>
            <option value="instalment_3" ${p?.fees?.instalmentPlan === 'instalment_3' ? 'selected' : ''}>Instalment 3</option>
            <option value="bajaj_emi" ${p?.fees?.instalmentPlan === 'bajaj_emi' ? 'selected' : ''}>No Cost EMI</option>
            <option value="cheque" ${p?.fees?.instalmentPlan === 'cheque' ? 'selected' : ''}>Cheque</option>
          </select>
        </div>
        
        <!-- Instalment Dates Section (Dynamic based on selection) -->
        <div id="instalmentDatesDiv" style="display:none; background:#ecfdf5; padding:12px; border-radius:8px; border:1px solid #6ee7b7;">
          <label style="font-size:12px; color:#065f46; text-transform:uppercase; letter-spacing:0.04em; font-weight:600; display:block; margin-bottom:8px;">Instalment Schedule</label>
          
          <!-- Dynamic Instalment Date Fields -->
          <div id="instalmentDateFields">
            <!-- Instalment 1 -->
            <div id="instalment1Field" style="display:none; margin-bottom:12px;">
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:end;">
                <div>
                  <label style="font-size:12px; color:#047857; font-weight:500;">Instalment 1 Date</label>
                  <input
                    type="date"
                    id="instalmentDate1"
                    name="instalmentDate1"
                    value="${p?.fees?.instalmentDates?.[0] ? new Date(p.fees.instalmentDates[0]).toISOString().split('T')[0] : ''}"
                    class="fee-input"
                    style="width:100%; margin-top:4px; border-color:#10b981;"
                    onchange="updateRemainingAmount()"
                  />
                </div>
                <div>
                  <label style="font-size:12px; color:#047857; font-weight:500;">Amount (₹)</label>
                  <input
                    type="number"
                    id="instalmentAmountInput1"
                    name="instalmentAmountInput1"
                    class="fee-input"
                    style="width:100%; margin-top:4px; border-color:#10b981;"
                    placeholder="Enter instalment 1 amount"
                    onchange="updateRemainingAmount()"
                    oninput="updateRemainingAmount()"
                  />
                </div>
              </div>
            </div>
            
            <!-- Instalment 2 -->
            <div id="instalment2Field" style="display:none; margin-bottom:12px;">
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:end;">
                <div>
                  <label style="font-size:12px; color:#047857; font-weight:500;">Instalment 2 Date</label>
                  <input
                    type="date"
                    id="instalmentDate2"
                    name="instalmentDate2"
                    value="${p?.fees?.instalmentDates?.[1] ? new Date(p.fees.instalmentDates[1]).toISOString().split('T')[0] : ''}"
                    class="fee-input"
                    style="width:100%; margin-top:4px; border-color:#10b981;"
                    onchange="updateRemainingAmount()"
                  />
                </div>
                <div>
                  <label style="font-size:12px; color:#047857; font-weight:500;">Amount (₹)</label>
                  <input
                    type="number"
                    id="instalmentAmountInput2"
                    name="instalmentAmountInput2"
                    class="fee-input"
                    style="width:100%; margin-top:4px; border-color:#10b981;"
                    placeholder="Enter instalment 2 amount"
                    onchange="updateRemainingAmount()"
                    oninput="updateRemainingAmount()"
                  />
                </div>
              </div>
            </div>
            
            <!-- Instalment 3 -->
            <div id="instalment3Field" style="display:none; margin-bottom:12px;">
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:end;">
                <div>
                  <label style="font-size:12px; color:#047857; font-weight:500;">Instalment 3 Date</label>
                  <input
                    type="date"
                    id="instalmentDate3"
                    name="instalmentDate3"
                    value="${p?.fees?.instalmentDates?.[2] ? new Date(p.fees.instalmentDates[2]).toISOString().split('T')[0] : ''}"
                    class="fee-input"
                    style="width:100%; margin-top:4px; border-color:#10b981;"
                    onchange="updateRemainingAmount()"
                  />
                </div>
                <div>
                  <label style="font-size:12px; color:#047857; font-weight:500;">Amount (₹)</label>
                  <input
                    type="number"
                    id="instalmentAmountInput3"
                    name="instalmentAmountInput3"
                    class="fee-input"
                    style="width:100%; margin-top:4px; border-color:#10b981;"
                    placeholder="Enter instalment 3 amount"
                    onchange="updateRemainingAmount()"
                    oninput="updateRemainingAmount()"
                  />
                </div>
              </div>
            </div>
          </div>
          
          <!-- Hidden fields for instalment data -->
          <input type="hidden" id="instalmentCount" name="instalmentCount" value="0" />
          <input type="hidden" id="instalmentAmountHidden1" name="instalmentAmount1" value="0" />
          <input type="hidden" id="instalmentAmountHidden2" name="instalmentAmount2" value="0" />
          <input type="hidden" id="instalmentAmountHidden3" name="instalmentAmount3" value="0" />
          
          <!-- Total Remaining Display -->
          <div id="totalRemainingDiv" style="margin-top:16px; padding:12px; background:#fef2f2; border:2px solid #ef4444; border-radius:8px; display:none;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:14px; color:#dc2626; font-weight:600;">Total Remaining:</span>
              <span style="font-size:20px; font-weight:700; color:#dc2626;">₹<span id="totalRemainingAmount">0</span></span>
            </div>
          </div>
        </div>
        
        <!-- Bajaj EMI Message (shown when Bajaj EMI selected) -->
        <div id="bajajEMIDiv" style="display:none; background:#fef3c7; padding:12px; border-radius:8px; border:1px solid #fbbf24; margin-top:12px;">
          <p style="margin:0; color:#92400e; font-weight:600;">🏦 No Cost EMI Process Selected</p>
          <p style="margin:4px 0 0 0; color:#a16207; font-size:13px;">Student has chosen No Cost EMI option. Admin will be notified to process this separately.</p>
          <input type="hidden" id="isBajajEMI" name="isBajajEMI" value="false" />
        </div>
        
        <!-- Cheque Payment Message (shown when Cheque selected) -->
        <div id="checkPaymentDiv" style="display:none; background:#f0f9ff; padding:12px; border-radius:8px; border:1px solid #38bdf8; margin-top:12px;">
          <p style="margin:0; color:#0369a1; font-weight:600;">📝 Cheque Payment Selected</p>
          <p style="margin:4px 0 0 0; color:#0c4a6e; font-size:13px;">Student has chosen Cheque payment option. Admin will be notified to process this separately.</p>
          <input type="hidden" id="isCheck" name="isCheck" value="false" />
        </div>
        
        <!-- No Cost EMI Message (shown when No Cost EMI selected in split fees) -->
        <div id="noCostEMISplitDiv" style="display:none; background:#dcfce7; padding:12px; border-radius:8px; border:1px solid #22c55e; margin-top:12px;">
          <p style="margin:0; color:#15803d; font-weight:600;">🏦 No Cost EMI Process Successfully Done</p>
          <p style="margin:4px 0 0 0; color:#166534; font-size:13px;">Counselor has selected No Cost EMI option for split fees payment. Admin will be notified to process this separately.</p>
          <input type="hidden" id="isNoCostEMISplit" name="isNoCostEMISplit" value="false" />
        </div>
      </div>

      <div class="actions-row">
        <button type="submit" class="btn-primary" formnovalidate>
          <span>✏️ Request Edit from Student</span>
        </button>

        <button
          type="submit"
          class="btn-success"
          formaction="/api/admissions/${doc._id}/submit-to-admin"
          formmethod="POST"
          onclick="return validateAndSubmit();"
        >
          <span>📤 Submit to Admin</span>
        </button>

        ${pdfUrl ? `<a href="${pdfUrl}" target="_blank" class="btn-ghost"><span>📄</span><span>Open PDF in new tab</span></a>` : ""}
      </div>

    </form>
  </div>

 <!-- <script>
    document.addEventListener("DOMContentLoaded", function () {
      // ==== 1) Section master auto-toggle (existing logic) ====
      const radios = document.querySelectorAll('input[type="radio"][data-section]');
      const sectionToRadios = {};

      radios.forEach(function (r) {
        const sec = r.getAttribute("data-section");
        if (!sectionToRadios[sec]) sectionToRadios[sec] = [];
        sectionToRadios[sec].push(r);
      });

      Object.keys(sectionToRadios).forEach(function (sec) {
        const master = document.querySelector('input[data-section-master="' + sec + '"]');
        if (!master) return;

        const update = function () {
          const anyBad = sectionToRadios[sec].some(function (r) {
            return r.checked && r.value === "fix";
          });
          master.checked = anyBad;
        };

        sectionToRadios[sec].forEach(function (r) {
          r.addEventListener("change", update);
        });

        // initial state
        update();
      });

     //  ==== 2) Auto-notes generation in "notes" textarea ====
      const notesBox = document.querySelector('textarea[name="notes"]');
      if (!notesBox) return;

      const autoNotes = new Set();

      radios.forEach(function (radio) {
        radio.addEventListener("change", function () {
          const fieldKey = radio.name;

          const fieldLabel = fieldKey
            .replace("pf_", "Personal: ")
            .replace("up_", "Upload: ")
            .replace("sg_", "Signature: ")
            .replace(/([A-Z])/g, " $1")
            .replace(/_/g, " ")
            .trim();

          const note = "• " + fieldLabel + " is missing or incorrect.";

          if (radio.value === "fix") {
            autoNotes.add(note);
            notesBox.value = Array.from(autoNotes).join("\\n");
          }

          if (radio.value === "ok") {
            if (autoNotes.has(note)) {
              autoNotes.delete(note);
              notesBox.value = Array.from(autoNotes).join("\\n");
            }
          }
            
        });
      });
    });
  </script> -->
  

<script>
  // ===============================
  // FEE CALCULATION FUNCTIONS
  // ===============================
  function calculatePendingFees() {
    var totalFees = parseFloat(document.getElementById('totalFees').value) || 0;
    var paidFees = parseFloat(document.getElementById('paidFees').value) || 0;
    var additionalFees = parseFloat(document.getElementById('additionalFees').value) || 0;
    var pendingFees = totalFees - paidFees - additionalFees;
    
    if (pendingFees < 0) pendingFees = 0;
    
    document.getElementById('pendingFees').value = pendingFees;
    document.getElementById('pendingFeesDisplay').textContent = pendingFees.toLocaleString('en-IN');
    
    // Recalculate instalment amount if instalment is selected
    handleInstalmentChange();
  }
  
  // Toggle Split Fees Section
  function toggleSplitFees() {
    var checkbox = document.getElementById('splitFeesCheckbox');
    var section = document.getElementById('splitFeesSection');
    if (checkbox.checked) {
      section.style.display = 'grid';
    } else {
      section.style.display = 'none';
      // Clear values when unchecked
      document.getElementById('additionalFees').value = '';
      document.getElementById('additionalFeeMode').value = '';
      calculatePendingFees();
    }
  }
  
  function handleInstalmentChange() {
    var instalmentPlan = document.getElementById('instalmentPlan').value;
    var instalmentDatesDiv = document.getElementById('instalmentDatesDiv');
    var bajajEMIDiv = document.getElementById('bajajEMIDiv');
    var checkPaymentDiv = document.getElementById('checkPaymentDiv');
    var instalmentCountInput = document.getElementById('instalmentCount');
    var isBajajEMIInput = document.getElementById('isBajajEMI');
    var isCheckInput = document.getElementById('isCheck');
    
    // Hide all first
    instalmentDatesDiv.style.display = 'none';
    bajajEMIDiv.style.display = 'none';
    checkPaymentDiv.style.display = 'none';
    document.getElementById('instalment1Field').style.display = 'none';
    document.getElementById('instalment2Field').style.display = 'none';
    document.getElementById('instalment3Field').style.display = 'none';
    
    if (instalmentPlan === 'bajaj_emi') {
      // Show Bajaj EMI message
      bajajEMIDiv.style.display = 'block';
      instalmentCountInput.value = 0;
      isBajajEMIInput.value = 'true';
      isCheckInput.value = 'false';
    } else if (instalmentPlan === 'cheque') {
      // Show Cheque Payment message
      checkPaymentDiv.style.display = 'block';
      instalmentCountInput.value = 0;
      isBajajEMIInput.value = 'false';
      isCheckInput.value = 'true';
    } else if (instalmentPlan.startsWith('instalment_')) {
      // Show instalment dates section
      instalmentDatesDiv.style.display = 'block';
      
      // Extract instalment count
      var count = 0;
      if (instalmentPlan === 'instalment_1') count = 1;
      else if (instalmentPlan === 'instalment_2') count = 2;
      else if (instalmentPlan === 'instalment_3') count = 3;
      
      instalmentCountInput.value = count;
      isBajajEMIInput.value = 'false';
      isCheckInput.value = 'false';
      
      // Show respective date fields
      if (count >= 1) document.getElementById('instalment1Field').style.display = 'block';
      if (count >= 2) document.getElementById('instalment2Field').style.display = 'block';
      if (count >= 3) document.getElementById('instalment3Field').style.display = 'block';
      
      // Show total remaining div and update it
      document.getElementById('totalRemainingDiv').style.display = 'block';
      updateRemainingAmount();
    } else {
      // No instalment selected
      instalmentCountInput.value = 0;
      isBajajEMIInput.value = 'false';
      isCheckInput.value = 'false';
    }
  }
  
  function handleAdditionalFeeModeChange() {
    var additionalFeeMode = document.getElementById('additionalFeeMode').value;
    var noCostEMISplitDiv = document.getElementById('noCostEMISplitDiv');
    var isNoCostEMISplitInput = document.getElementById('isNoCostEMISplit');
    
    if (additionalFeeMode === 'no_cost_emi') {
      noCostEMISplitDiv.style.display = 'block';
      isNoCostEMISplitInput.value = 'true';
    } else {
      noCostEMISplitDiv.style.display = 'none';
      isNoCostEMISplitInput.value = 'false';
    }
  }
  
  // This function is no longer used - kept for compatibility
  function updateInstalmentAmounts() {
    // Just update the remaining amount calculation
    updateRemainingAmount();
  }
  
  function updateRemainingAmount() {
    var pendingFees = parseFloat(document.getElementById('pendingFees').value) || 0;
    var instalmentPlan = document.getElementById('instalmentPlan').value;
    
    if (!instalmentPlan.startsWith('instalment_')) {
      document.getElementById('totalRemainingDiv').style.display = 'none';
      return;
    }
    
    var count = 0;
    if (instalmentPlan === 'instalment_1') count = 1;
    else if (instalmentPlan === 'instalment_2') count = 2;
    else if (instalmentPlan === 'instalment_3') count = 3;
    
    var totalEntered = 0;
    for (var i = 1; i <= count; i++) {
      var inputEl = document.getElementById('instalmentAmountInput' + i);
      var hiddenEl = document.getElementById('instalmentAmountHidden' + i);
      var amount = parseFloat(inputEl?.value) || 0;
      
      totalEntered += amount;
      
      // Update hidden field
      if (hiddenEl) hiddenEl.value = amount;
    }
    
    var remaining = pendingFees - totalEntered;
    var remainingEl = document.getElementById('totalRemainingAmount');
    var remainingDiv = document.getElementById('totalRemainingDiv');
    
    if (remainingEl) {
      remainingEl.textContent = remaining.toLocaleString('en-IN');
    }
    
    // Update color based on remaining amount
    if (remainingDiv) {
      if (remaining === 0) {
        remainingDiv.style.background = '#f0fdf4';
        remainingDiv.style.borderColor = '#22c55e';
        remainingDiv.querySelector('span').style.color = '#16a34a';
        remainingDiv.querySelector('span:last-child').style.color = '#16a34a';
      } else if (remaining < 0) {
        remainingDiv.style.background = '#fef2f2';
        remainingDiv.style.borderColor = '#ef4444';
        remainingDiv.querySelector('span').style.color = '#dc2626';
        remainingDiv.querySelector('span:last-child').style.color = '#dc2626';
      } else {
        remainingDiv.style.background = '#fef2f2';
        remainingDiv.style.borderColor = '#ef4444';
        remainingDiv.querySelector('span').style.color = '#dc2626';
        remainingDiv.querySelector('span:last-child').style.color = '#dc2626';
      }
    }
  }
  
  function validateAndSubmit() {
    var feeMode = document.getElementById('feeMode').value;
    var instalmentPlan = document.getElementById('instalmentPlan').value;
    var totalFees = parseFloat(document.getElementById('totalFees').value) || 0;
    var paidFees = parseFloat(document.getElementById('paidFees').value) || 0;
    
    // Validation
    if (totalFees <= 0) {
      alert('Please enter Total Fees greater than 0');
      return false;
    }
    
    if (paidFees <= 0) {
      alert('Please enter Paid Fees greater than 0');
      return false;
    }
    
    if (!feeMode) {
      alert('Please select a Payment Mode');
      return false;
    }
    
    // Validate instalment dates
    if (instalmentPlan.startsWith('instalment_')) {
      var count = 0;
      if (instalmentPlan === 'instalment_1') count = 1;
      else if (instalmentPlan === 'instalment_2') count = 2;
      else if (instalmentPlan === 'instalment_3') count = 3;
      
      for (var i = 1; i <= count; i++) {
        var dateField = document.getElementById('instalmentDate' + i);
        if (!dateField || !dateField.value) {
          alert('Please select date for Instalment ' + i);
          return false;
        }
      }
    }
    
    // Show loading overlay
    document.getElementById('loading-overlay').style.display = 'flex';
    return true;
  }
  
  // Initialize on page load
  document.addEventListener("DOMContentLoaded", function () {
    // Initialize fee calculations
    calculatePendingFees();
    handleInstalmentChange();
    
    // ==== 1) Section master auto-toggle (existing logic) ====
    const radios = document.querySelectorAll('input[type="radio"][data-section]');
    const sectionToRadios = {};

    radios.forEach(function (r) {
      const sec = r.getAttribute("data-section");
      if (!sectionToRadios[sec]) sectionToRadios[sec] = [];
      sectionToRadios[sec].push(r);
    });

    Object.keys(sectionToRadios).forEach(function (sec) {
      const master = document.querySelector('input[data-section-master="' + sec + '"]');
      if (!master) return;

      const update = function () {
        const anyBad = sectionToRadios[sec].some(function (r) {
          return r.checked && r.value === "fix";
        });
        master.checked = anyBad;
      };

      sectionToRadios[sec].forEach(function (r) {
        r.addEventListener("change", update);
      });

      // initial state
      update();
    });

    /* ===============================
       2) AUTO NOTES – FIELD LEVEL
    =============================== */
    var notesBox = document.querySelector('textarea[name="notes"]');
    if (!notesBox) return;

    var autoNotes = new Set();

    radios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        var fieldKey = radio.name;

        var fieldLabel = fieldKey
          .replace("pf_", "Personal: ")
          .replace("up_", "Upload: ")
          .replace("sg_", "Signature: ")
          .replace(/_/g, " ");

        var note = "• " + fieldLabel + " is missing or incorrect.";

        var valueBox =
          document.querySelector('.field-value[data-field="' + fieldKey + '"]') ||
          document.querySelector('input[data-field="' + fieldKey + '"]') ||
          document.querySelector('select[data-field="' + fieldKey + '"]');

        if (radio.value === "fix") {
          autoNotes.add(note);
          if (valueBox) {
            valueBox.classList.remove("field-ok");
            valueBox.classList.add("field-flagged");
          }
        }

        if (radio.value === "ok") {
          autoNotes.delete(note);
          if (valueBox) {
            valueBox.classList.remove("field-flagged");
            valueBox.classList.add("field-ok");
          }
        }

        notesBox.value = Array.from(autoNotes).join("\\n");
      });
    });

    /* ===============================
       3) SECTION-LEVEL ❌ CHECKBOX
       ✅ THIS IS THE FIX
    =============================== */
    var sectionFixCheckboxes = document.querySelectorAll(
      'input[type="checkbox"][name="sections"]:not([disabled])'
    );

    function sectionHeading(section) {
      var map = {
        personal: "• Personal Information",
        course: "• Course Details",
        education: "• Educational Details",
        ids: "• ID Details",
        uploads: "• Uploads",
        center: "• Center Details",
        signatures: "• Signatures",
        other: "• Other Issues"
      };
      return map[section] || "• " + section;
    }

    sectionFixCheckboxes.forEach(function (chk) {
      chk.addEventListener("change", function () {
        var note = sectionHeading(chk.value);

        if (chk.checked) {
          autoNotes.add(note);
        } else {
          autoNotes.delete(note);
        }

        notesBox.value = Array.from(autoNotes).join("\\n");
      });
    });
  });
</script>


</body>
</html>`;

    res.status(200).send(html);
  } catch (e) {
    console.error("reviewAdmissionPage failed:", e);
    res.status(500).send("<h2>Server error</h2>");

    
  }
}

/* ==================== ADMIN REVIEW PAGE (HTML) ==================== */
async function adminReviewAdmissionPage(req, res) {
  try {
    const { id } = req.params;
    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).send("<h2>Admission not found</h2>");

    const p = doc.toObject();

    const editReq = p.editRequest || {};
    const flaggedFields = Array.isArray(editReq.fields) ? editReq.fields : [];
    const lastNotes = editReq.notes || "";

    const pdfUrl =
      p?.pdf?.pendingCounselorUrl ||
      p?.pdf?.pendingStudentUrl ||
      p?.pdf?.approvedUrl ||
      "";

   const feeAmount =
  p?.fees?.amount !== undefined && p?.fees?.amount !== null
    ? p.fees.amount
    : "";

const feeMode =
  typeof p?.fees?.paymentMode === "string"
    ? p.fees.paymentMode
    : "";

   const eduRows =
  (p.education || []).length > 0
    ? (p.education || [])
        .map(
          (ed, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${ed.qualification || "-"}</td>
        <td>${ed.school || "-"}</td>
        <td>${ed.year || "-"}</td>
        <td>${ed.percentage || "-"}</td>
      </tr>`
        )
        .join("")
    : `<tr>
         <td colspan="5" style="padding:6px 8px;font-size:13px;color:#6b7280;">
           No education details filled.
         </td>
       </tr>`;


    const jobType = p?.course?.trainingOnly
  ? "No Job Guarantee – Training only"
  : "Job Guarantee Training";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Awdiz Admission Review – ${p.personal?.name || ""}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:#e5e7eb;
      margin:0;
      padding:24px 12px;
    }
    .page {
      max-width: 1080px;
      margin:0 auto;
      background:#f9fafb;
      border-radius:12px;
      border:1px solid #e5e7eb;
      padding:20px;
    }
    .header {
      display:flex;
      justify-content:space-between;
      align-items:center;
      margin-bottom:14px;
    }
    .title {
      font-size:20px;
      font-weight:600;
      margin:0;
    }
    .subtitle {
      font-size:13px;
      color:#6b7280;
      margin-top:4px;
    }
    .pdf-pane {
      border:1px solid #e5e7eb;
      border-radius:10px;
      overflow:hidden;
      background:#111827;
      margin-bottom:16px;
    }
    .pdf-pane-header {
      display:flex;
      justify-content:space-between;
      align-items:center;
      padding:10px 14px;
      background:#111827;
      color:#f9fafb;
      font-size:13px;
    }
    .pdf-frame {
      width:100%;
      height:480px;
      border:0;
      background:#111827;
    }
    .btn-inline {
      display:inline-flex;
      align-items:center;
      gap:6px;
      font-size:13px;
      padding:6px 10px;
      border-radius:999px;
      border:1px solid #4b5563;
      color:#e5e7eb;
      text-decoration:none;
      background:transparent;
    }
    .btn-inline span.icon { font-size:15px; }

    form#review-form {
      margin-top:4px;
    }
    .section-card {
      background:#ffffff;
      border-radius:10px;
      border:1px solid #e5e7eb;
      padding:14px 16px;
      margin-top:10px;
    }
    .sec-header {
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      margin-bottom:8px;
      gap:8px;
    }
    .sec-title {
      font-size:14px;
      font-weight:600;
      margin:0;
    }
    .sec-badges {
      display:flex;
      gap:8px;
      font-size:12px;
    }
    .badge {
      display:inline-flex;
      align-items:center;
      gap:4px;
      padding:2px 8px;
      border-radius:999px;
      border:1px solid #d1d5db;
      background:#f9fafb;
      color:#374151;
    }
    .badge input {
      margin:0;
    }
    .grid-2 {
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:8px 16px;
      font-size:13px;
    }
    .field-label {
      font-size:12px;
      text-transform:uppercase;
      letter-spacing:.04em;
      color:#6b7280;
      margin-bottom:2px;
    }
    .field-value {
      font-size:13px;
      color:#111827;
      padding:4px 6px;
      border-radius:6px;
      background:#f9fafb;
      border:1px dashed #e5e7eb;
      min-height:26px;
    }
    .field-flagged {
      border-color:#ef4444 !important;
      background:#fef2f2 !important;
      color:#b91c1c;
    }
    table.edu {
      width:100%;
      border-collapse:collapse;
      font-size:12px;
      margin-top:4px;
    }
    .edu th, .edu td {
      border:1px solid #e5e7eb;
      padding:4px 6px;
      text-align:left;
    }
    .edu th {
      background:#f3f4f6;
      font-weight:600;
    }
    .notes-box {
      width:100%;
      min-height:70px;
      border-radius:8px;
      border:1px solid #d1d5db;
      padding:8px 10px;
      font-size:13px;
      resize:vertical;
    }
    .actions-row {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      margin-top:14px;
      align-items:center;
    }
    .btn-primary {
      border:none;
      border-radius:999px;
      padding:10px 18px;
      font-size:14px;
      font-weight:600;
      cursor:pointer;
      display:inline-flex;
      align-items:center;
      gap:8px;
      background:#f97316;
      color:#ffffff;
    }
    .btn-primary:hover { background:#ea580c; }
    .btn-success {
      border:none;
      border-radius:999px;
      padding:10px 18px;
      font-size:14px;
      font-weight:600;
      cursor:pointer;
      display:inline-flex;
      align-items:center;
      gap:8px;
      background:#16a34a;
      color:#ffffff;
      text-decoration:none;
    }
    .btn-success:hover { background:#15803d; }
    .btn-ghost {
      border-radius:999px;
      padding:8px 14px;
      font-size:13px;
      display:inline-flex;
      align-items:center;
      gap:8px;
      border:1px solid #e5e7eb;
      background:#ffffff;
      color:#111827;
      text-decoration:none;
      cursor:pointer;
    }
    .helper {
      margin-top:6px;
      font-size:12px;
      color:#6b7280;
    }

    /* ==== NEW for per-field flags ==== */
    .field-row {
      display:flex;
      align-items:flex-start;
      gap:8px;
      margin-bottom:8px;
    }
    .field-main {
      flex:1 1 auto;
    }
    .field-flags {
      display:flex;
      flex-direction:row;
      gap:4px;
      align-items:center;
      font-size:11px;
      white-space:nowrap;
    }
    .mini-badge {
      display:inline-flex;
      align-items:center;
      gap:2px;
      padding:1px 6px;
      border-radius:999px;
      border:1px solid #d1d5db;
      background:#f9fafb;
      color:#374151;
    }
    .mini-badge input {
      margin:0;
    }
    .hidden-section-checkbox {
      display:none;
    }
      .admin-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap; /* mobile pe niche aa sake */
}

.admin-actions .fee-input {
  width: 140px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
}

.admin-actions .fee-select {
  width: 130px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  background: #fff;
}

/* Buttons alignment fix */
.admin-actions .btn-primary,
.admin-actions .btn-success {
  white-space: nowrap;
}

/* Mobile optimization */
@media (max-width: 768px) {
  .admin-actions {
    gap: 10px;
  }

  .admin-actions .fee-input,
  .admin-actions .fee-select {
    width: 100%;
  }
}


    @media (max-width:768px){
      .grid-2 { grid-template-columns:1fr; }
      .pdf-frame { height:380px; }
    }
  
      .fee-row{
        display:flex;
        gap:10px;
        align-items:center;
        flex-wrap:wrap;
      }
      .fee-input{
        
        min-width:160px;
        padding:10px 12px;
        border:1px solid #e5e7eb;
        border-radius:10px;
        outline:none;
      }
      .fee-select{
        min-width:140px;
        padding:10px 12px;
        border:1px solid #e5e7eb;
        border-radius:10px;
        outline:none;
        background:#fff;
      }
      .submit-admin-form{ margin:0; }
      /* live review states */
.field-ok {
  border-color: #93c5fd;      /* blue */
  background: #eff6ff;
  color: #1e3a8a;
}

/* loading overlay */
#loading-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 9999;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.3);
}
#loading-overlay .loader-box {
  background: #fff;
  padding: 20px 24px;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.15);
  display: flex;
  align-items: center;
  gap: 12px;
}
#loading-overlay .spinner {
  width: 24px;
  height: 24px;
  border: 3px solid #e5e7eb;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ==================== RESPONSIVE STYLES ==================== */
@media (max-width: 768px) {
  body {
    padding: 12px 8px;
  }
  .page {
    padding: 12px;
    border-radius: 8px;
  }
  .header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .title {
    font-size: 18px;
  }
  .pdf-frame {
    height: 300px;
  }
  .grid-2 {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .field-row {
    flex-direction: column;
    gap: 6px;
  }
  .field-flags {
    justify-content: flex-end;
  }
  .sec-header {
    flex-direction: column;
    gap: 8px;
  }
  .sec-badges {
    flex-wrap: wrap;
  }
  .actions-row {
    flex-direction: column;
    align-items: stretch;
  }
  .btn-primary, .btn-success, .btn-ghost {
    width: 100%;
    justify-content: center;
  }
  .fee-row {
    flex-direction: column;
    align-items: stretch;
  }
  .fee-input, .fee-select {
    width: 100%;
    min-width: auto;
  }
  table.edu {
    font-size: 11px;
  }
  .edu th, .edu td {
    padding: 3px 4px;
  }
  .pdf-pane-header {
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
  #totalRemainingDiv {
    margin-top: 12px;
  }
  #totalRemainingDiv span:last-child {
    font-size: 18px;
  }
}

@media (max-width: 480px) {
  .title {
    font-size: 16px;
  }
  .subtitle {
    font-size: 12px;
  }
  .pdf-frame {
    height: 250px;
  }
  .section-card {
    padding: 10px 12px;
  }
  .sec-title {
    font-size: 13px;
  }
  .field-label {
    font-size: 11px;
  }
  .field-value {
    font-size: 12px;
    padding: 3px 5px;
  }
  .btn-primary, .btn-success {
    padding: 12px 16px;
    font-size: 13px;
  }
  .badge {
    font-size: 11px;
    padding: 2px 6px;
  }
  .mini-badge {
    font-size: 10px;
    padding: 1px 4px;
  }
  .notes-box {
    min-height: 60px;
    font-size: 12px;
  }
}

</style>
</head>
<body>
  <!-- loading overlay -->
  <div id="loading-overlay">
    <div class="loader-box">
      <div class="spinner"></div>
      <span style="font-weight:600;color:#374151;">Submitting to Admin…</span>
    </div>
  </div>

  <div class="page">
    <div class="header">
      <div>
        <h1 class="title">Awdiz Admission Review</h1>
        <p class="subtitle">
          Student: <b>${p.personal?.name || "-"}</b> &middot; Course: <b>${p.course?.name || "-"}</b>
        </p>
      </div>
    </div>

    <!-- PDF preview -->
    <div class="pdf-pane">
      <div class="pdf-pane-header">
        <div>Pending Admission PDF</div>
        <div>
          ${
            pdfUrl
              ? `<a class="btn-inline" href="${pdfUrl}" target="_blank"><span class="icon">📄</span><span>Open PDF in new tab</span></a>`
              : `<span style="font-size:12px;color:#9ca3af;">No PDF URL found</span>`
          }
        </div>
      </div>
      ${
        pdfUrl
          ? `<iframe
  class="pdf-frame"
  src="${pdfUrl}#toolbar=0&navpanes=0"
></iframe>`
          : `<div style="padding:18px;font-size:13px;color:#9ca3af;">PDF not available.</div>`
      }
    </div>

    <!-- REVIEW FORM -->
    <form id="review-form" method="POST" action="/api/admissions/${doc._id}/request-edit">

      <!-- PERSONAL (field-wise flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Personal Information</p>
        </div>

        <!-- hidden master checkbox for backend -->
        <input
          type="checkbox"
          name="sections"
          value="personal"
          data-section-master="personal"
          class="hidden-section-checkbox"
        />

        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Full Name</div>
              <div data-field="pf_fullName"
  class="field-value${flaggedFields.includes("pf_fullName") ? " field-flagged" : ""}">
${p.personal?.salutation || ""} ${p.personal?.name || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_fullName" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_fullName" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Father / Guardian Name</div>
              <div data-field="pf_guardian" class="field-value${
                flaggedFields.includes("pf_guardian") ? " field-flagged" : ""
              }">${p.personal?.fatherOrGuardianName || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_guardian" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_guardian" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Address</div>
              <div data-field="pf_address" class="field-value${
                flaggedFields.includes("pf_address") ? " field-flagged" : ""
              }">${p.personal?.address || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_address" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_address" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Student Mobile</div>
              <div data-field="pf_studentMobile" class="field-value${
                flaggedFields.includes("pf_studentMobile") ? " field-flagged" : ""
              }">${p.personal?.studentMobile || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_studentMobile" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_studentMobile" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">WhatsApp Mobile</div>
              <div data-field="pf_whatsapp" class="field-value${
                flaggedFields.includes("pf_whatsapp") ? " field-flagged" : ""
              }">${p.personal?.whatsappMobile || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_whatsapp" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_whatsapp" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Parent Mobile</div>
              <div data-field="pf_parentMobile" class="field-value${
                flaggedFields.includes("pf_parentMobile") ? " field-flagged" : ""
              }">${p.personal?.parentMobile || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_parentMobile" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_parentMobile" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Email</div>
              <div data-field="pf_email" class="field-value${
                flaggedFields.includes("pf_email") ? " field-flagged" : ""
              }">${p.personal?.email || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="pf_email" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="pf_email" value="fix" data-section="personal" />
                ❌
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- COURSE (with field-level flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Course Details</p>
          <!-- hidden master checkbox for backend -->
          <input
            type="checkbox"
            name="sections"
            value="course"
            data-section-master="course"
            class="hidden-section-checkbox"
          />
        </div>
        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Course Name</div>
              <div data-field="cr_name" class="field-value${flaggedFields.includes("cr_name") ? " field-flagged" : ""}">${p.course?.name || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="cr_name" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="cr_name" value="fix" data-section="course" /> ❌</label>
            </div>
          </div>
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Reference</div>
              <div data-field="cr_reference" class="field-value${flaggedFields.includes("cr_reference") ? " field-flagged" : ""}">${p.course?.reference || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="cr_reference" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="cr_reference" value="fix" data-section="course" /> ❌</label>
            </div>
          </div>
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Plan Type</div>
              <div data-field="cr_planType" class="field-value${flaggedFields.includes("cr_planType") ? " field-flagged" : ""}">${jobType}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="cr_planType" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="cr_planType" value="fix" data-section="course" /> ❌</label>
            </div>
          </div>
        </div>
      </div>

      <!-- EDUCATION (same) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Educational Details</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
            <label class="badge"><input type="checkbox" name="sections" value="education" /> ❌ Needs correction</label>
          </div>
        </div>
        <table class="edu">
          <thead>
            <tr>
              <th>#</th>
              <th>Qualification</th>
              <th>School / College</th>
              <th>Year</th>
              <th>% Marks</th>
            </tr>
          </thead>
          <tbody>${eduRows}</tbody>
        </table>
      </div>

      <!-- IDS (with field-level flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">ID Details</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
            <label class="badge"><input type="checkbox" name="sections" value="ids" /> ❌ Needs correction</label>
          </div>
        </div>
        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">PAN Number</div>
              <div data-field="id_pan" class="field-value${flaggedFields.includes("id_pan") ? " field-flagged" : ""}">${p.ids?.pan || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="id_pan" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="id_pan" value="fix" data-section="ids" /> ❌</label>
            </div>
          </div>
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Aadhaar / Driving</div>
              <div data-field="id_aadhaar" class="field-value${flaggedFields.includes("id_aadhaar") ? " field-flagged" : ""}">${p.ids?.aadhaarOrDriving || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="id_aadhaar" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="id_aadhaar" value="fix" data-section="ids" /> ❌</label>
            </div>
          </div>
        </div>
      </div>

      <!-- UPLOADS (field-wise flags, master = "uploads") -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Uploads</p>
        </div>

        <input
          type="checkbox"
          name="sections"
          value="uploads"
          data-section-master="uploads"
          class="hidden-section-checkbox"
        />

        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Passport Photo</div>
              <div data-field="up_photo" class="field-value${
  flaggedFields.includes("up_photo") ? " field-flagged" : ""
}">
  ${
    p.uploads?.photoUrl
      ? `<img 
           src="${p.uploads.photoUrl}" 
           alt="Passport Photo"
           style="max-width:120px;max-height:120px;border-radius:8px;border:1px solid #e5e7eb"
         />`
      : "-"
  }
</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="up_photo" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="up_photo" value="fix" data-section="uploads" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">PAN</div>
              <div data-field="up_pan" class="field-value${
  flaggedFields.includes("up_pan") ? " field-flagged" : ""
}">
  ${
    p.uploads?.panUrl
      ? (/\.(png|jpg|jpeg|webp)$/i.test(p.uploads.panUrl)
          ? `<img src="${p.uploads.panUrl}" alt="PAN" style="max-width:140px;max-height:140px;border-radius:8px;border:1px solid #e5e7eb" />`
          : `<a href="${p.uploads.panUrl}" target="_blank">📄 View PAN Document</a>`)
      : "-"
  }
</div>

            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="up_pan" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="up_pan" value="fix" data-section="uploads" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Aadhaar</div>
              <div data-field="up_aadhaar" class="field-value${
  flaggedFields.includes("up_aadhaar") ? " field-flagged" : ""
}">
  ${
    p.uploads?.aadhaarUrl
      ? (/\.(png|jpg|jpeg|webp)$/i.test(p.uploads.aadhaarUrl)
          ? `<img src="${p.uploads.aadhaarUrl}" alt="Aadhaar" style="max-width:140px;max-height:140px;border-radius:8px;border:1px solid #e5e7eb" />`
          : `<a href="${p.uploads.aadhaarUrl}" target="_blank">📄 View Aadhaar Document</a>`)
      : "-"
  }
</div>

            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="up_aadhaar" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="up_aadhaar" value="fix" data-section="uploads" />
                ❌
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- CENTER (with field-level flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Center Details</p>
          <!-- hidden master checkbox for backend -->
          <input
            type="checkbox"
            name="sections"
            value="center"
            data-section-master="center"
            class="hidden-section-checkbox"
          />
        </div>
        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Place of Admission</div>
              <div data-field="center_place" class="field-value${flaggedFields.includes("center_place") ? " field-flagged" : ""}">${p.center?.placeOfAdmission || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="center_place" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="center_place" value="fix" data-section="center" /> ❌</label>
            </div>
          </div>
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Mode</div>
              <div data-field="center_mode" class="field-value${flaggedFields.includes("center_mode") ? " field-flagged" : ""}">${p.center?.mode || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge"><input type="radio" name="center_mode" value="ok" checked /> ✅</label>
              <label class="mini-badge"><input type="radio" name="center_mode" value="fix" data-section="center" /> ❌</label>
            </div>
          </div>
        </div>
      </div>

      <!-- SIGNATURES (field-wise flags) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Signatures</p>
        </div>

        <input
          type="checkbox"
          name="sections"
          value="signatures"
          data-section-master="signatures"
          class="hidden-section-checkbox"
        />

        <div class="field-row">
          <div class="field-main">
            <div class="field-label">Student Name</div>
            <div data-field="sg_student_name" class="field-value${flaggedFields.includes("sg_student_name") ? " field-flagged" : ""}">${p.signatures?.student?.fullName || "-"}</div>
          </div>
          <div class="field-flags">
            <label class="mini-badge"><input type="radio" name="sg_student_name" value="ok" checked /> ✅</label>
            <label class="mini-badge"><input type="radio" name="sg_student_name" value="fix" data-section="signatures" /> ❌</label>
          </div>
        </div>

        <div class="field-row">
          <div class="field-main">
            <div class="field-label">Student Signature</div>
            <div data-field="sg_student_sign" class="field-value${flaggedFields.includes("sg_student_sign") ? " field-flagged" : ""}">
              ${(p.signatures?.student?.signUrl || p.signatures?.student?.signDataUrl)
                ? `<img src="${p.signatures?.student?.signUrl || p.signatures?.student?.signDataUrl}" alt="Student Signature" style="height:42px;max-width:220px;object-fit:contain;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:4px" />`
                : `<span style="font-size:12px;color:#6b7280;">No signature</span>`
              }
            </div>
          </div>
          <div class="field-flags">
            <label class="mini-badge"><input type="radio" name="sg_student_sign" value="ok" checked /> ✅</label>
            <label class="mini-badge"><input type="radio" name="sg_student_sign" value="fix" data-section="signatures" /> ❌</label>
          </div>
        </div>

        <div class="field-row">
          <div class="field-main">
            <div class="field-label">Parent / Guardian Name</div>
            <div data-field="sg_parent_name" class="field-value${flaggedFields.includes("sg_parent_name") ? " field-flagged" : ""}">${p.signatures?.parent?.fullName || "-"}</div>
          </div>
          <div class="field-flags">
            <label class="mini-badge"><input type="radio" name="sg_parent_name" value="ok" checked /> ✅</label>
            <label class="mini-badge"><input type="radio" name="sg_parent_name" value="fix" data-section="signatures" /> ❌</label>
          </div>
        </div>

        <div class="field-row">
          <div class="field-main">
            <div class="field-label">Parent / Guardian Signature</div>
            <div data-field="sg_parent_sign" class="field-value${flaggedFields.includes("sg_parent_sign") ? " field-flagged" : ""}">
              ${(p.signatures?.parent?.signUrl || p.signatures?.parent?.signDataUrl)
                ? `<img src="${p.signatures?.parent?.signUrl || p.signatures?.parent?.signDataUrl}" alt="Parent Signature" style="height:42px;max-width:220px;object-fit:contain;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:4px" />`
                : `<span style="font-size:12px;color:#6b7280;">No signature</span>`
              }
            </div>
          </div>
          <div class="field-flags">
            <label class="mini-badge"><input type="radio" name="sg_parent_sign" value="ok" checked /> ✅</label>
            <label class="mini-badge"><input type="radio" name="sg_parent_sign" value="fix" data-section="signatures" /> ❌</label>
          </div>
        </div>

        </div>
      </div>

      <!-- NOTES -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Notes to Student (optional)</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" name="sections" value="other" /> ❌ Other issue</label>
          </div>
        </div>
        <textarea name="notes" class="notes-box" placeholder="Example: Please correct spelling of your name and upload a clearer Aadhaar scan.">${lastNotes}</textarea>
        <p class="helper">Jo sections yahan ❌ select karenge, unhi ko baad me student ke form me editable rakha jaa sakta hai.</p>
      </div>

      <!-- FEE DETAILS DISPLAY FOR ADMIN -->
      <div class="section-card" style="background:#f0fdf4; border-color:#86efac;">
        <div class="sec-header">
          <p class="sec-title" style="color:#15803d;">💰 Fee Details (Submitted by Counselor)</p>
        </div>
        
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; font-size:13px;">
          <div>
            <div class="field-label">Total Fees</div>
            <div class="field-value">₹${p?.fees?.totalFees || 0}</div>
          </div>
          <div>
            <div class="field-label">Paid Fees</div>
            <div class="field-value">₹${feeAmount !== "" ? feeAmount : 0}</div>
          </div>
          <div>
            <div class="field-label">Pending Fees</div>
            <div class="field-value">₹${p?.fees?.pendingFees || 0}</div>
          </div>
          <div>
            <div class="field-label">Payment Mode</div>
            <div class="field-value">${feeMode ? feeMode.toUpperCase() : "-"}</div>
          </div>
          ${(p?.fees?.additionalFees > 0 || p?.fees?.additionalFeeMode) ? `
          <div>
            <div class="field-label">Split Fees</div>
            <div class="field-value">₹${p?.fees?.additionalFees || 0}</div>
          </div>
          <div>
            <div class="field-label">Split Payment Mode</div>
            <div class="field-value">${p?.fees?.additionalFeeMode ? p?.fees?.additionalFeeMode.toUpperCase() : "-"}</div>
          </div>
          ${p?.fees?.additionalFeeMode === 'no_cost_emi' ? `
          <div style="margin-top:8px; padding:10px; background:#dcfce7; border-radius:4px; border-left:4px solid #22c55e;">
            <p style="margin:0; color:#15803d; font-weight:600;">🏦 No Cost EMI Process Successfully Done</p>
          </div>
          ` : ""}
          ` : ""}
        </div>
        
        ${p?.fees?.instalmentPlan?.startsWith('instalment_') ? `
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid #86efac;">
          <p style="margin:0 0 8px; font-weight:600; color:#15803d;">📅 Instalment Schedule:</p>
          ${(p?.fees?.instalmentDates || []).map((date, idx) => {
            const amount = p?.fees?.instalmentAmounts?.[idx] || 0;
            const dateStr = date ? new Date(date).toLocaleDateString("en-IN", { day: 'numeric', month: 'long' }) : 'TBD';
            return `
              <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px dashed #86efac;">
                <span style="color:#166534; font-weight:500;">Instalment ${idx + 1}</span>
                <span style="color:#166534;">₹${amount} on ${dateStr}</span>
              </div>
            `;
          }).join('')}
        </div>
        ` : ""}
        
        ${p?.fees?.instalmentPlan === "bajaj_emi" || p?.fees?.isBajajEMI ? `
        <div style="margin-top:12px; padding:12px; background:#fef3c7; border-radius:8px; border:1px solid #fbbf24;">
          <p style="margin:0; color:#92400e; font-weight:600;">🏦 No Cost EMI PROCESS SELECTED</p>
          <p style="margin:4px 0 0 0; color:#78350f; font-size:13px;">Student has chosen No Cost EMI option for fee payment.</p>
        </div>
        ` : ""}
        
        ${p?.fees?.instalmentPlan === "cheque" || p?.fees?.isCheck ? `
        <div style="margin-top:12px; padding:12px; background:#f0f9ff; border-radius:8px; border:1px solid #38bdf8;">
          <p style="margin:0; color:#0369a1; font-weight:600;">📝 CHEQUE PAYMENT SELECTED</p>
          <p style="margin:4px 0 0 0; color:#0c4a6e; font-size:13px;">Student has chosen Cheque payment option for fee payment.</p>
        </div>
        ` : ""}
      </div>

      <div class="actions-row admin-actions">

  <button
    type="submit"
    class="btn-primary"
    formaction="/api/admissions/${doc._id}/request-edit-counselor"
    formmethod="POST"
  >
    ✏️ Request Edit from Counselor
  </button>

  <input
    type="number"
    name="feeAmount"
    class="fee-input"
    min="0"
    step="1"
    placeholder="Registration Fees"
    value="${feeAmount !== "" ? feeAmount : ""}"
    required
  />

  <select name="feeMode" class="fee-select" required>
    <option value="cash" ${feeMode === "cash" ? "selected" : ""}>Cash</option>
    <option value="online" ${feeMode === "online" ? "selected" : ""}>Online</option>
    <option value="instalment" ${feeMode === "instalment" ? "selected" : ""}>Instalment</option>
    <option value="bajaj_emi" ${feeMode === "bajaj_emi" ? "selected" : ""}>No Cost EMI</option>
    <option value="check" ${feeMode === "check" ? "selected" : ""}>Check</option>
  </select>

  <button
    type="submit"
    class="btn-success"
    formaction="/api/admissions/${doc._id}/approve"
    formmethod="POST"
    onclick="showApproveLoading()"
  >
    ✅ Approve Admission
  </button>

</div>



    </form>
  </div>


<script>
 document.addEventListener("DOMContentLoaded", function () {
      // ==== 1) Section master auto-toggle (existing logic) ====
      const radios = document.querySelectorAll('input[type="radio"][data-section]');
      const sectionToRadios = {};

      radios.forEach(function (r) {
        const sec = r.getAttribute("data-section");
        if (!sectionToRadios[sec]) sectionToRadios[sec] = [];
        sectionToRadios[sec].push(r);
      });

      Object.keys(sectionToRadios).forEach(function (sec) {
        const master = document.querySelector('input[data-section-master="' + sec + '"]');
        if (!master) return;

        const update = function () {
          const anyBad = sectionToRadios[sec].some(function (r) {
            return r.checked && r.value === "fix";
          });
          master.checked = anyBad;
        };

        sectionToRadios[sec].forEach(function (r) {
          r.addEventListener("change", update);
        });

        // initial state
        update();
      });

  /* ===============================
     2) AUTO NOTES – FIELD LEVEL
  =============================== */
  var notesBox = document.querySelector('textarea[name="notes"]');
  if (!notesBox) return;

  var autoNotes = new Set();

  radios.forEach(function (radio) {
    radio.addEventListener("change", function () {
      var fieldKey = radio.name;

      var fieldLabel = fieldKey
        .replace("pf_", "Personal: ")
        .replace("up_", "Upload: ")
        .replace("sg_", "Signature: ")
        .replace(/_/g, " ");

      var note = "• " + fieldLabel + " is missing or incorrect.";

      var valueBox =
  document.querySelector('.field-value[data-field="' + fieldKey + '"]') ||
  document.querySelector('input[data-field="' + fieldKey + '"]') ||
  document.querySelector('select[data-field="' + fieldKey + '"]');

      if (radio.value === "fix") {
        autoNotes.add(note);
        if (valueBox) {
          valueBox.classList.remove("field-ok");
          valueBox.classList.add("field-flagged");
        }
      }

      if (radio.value === "ok") {
        autoNotes.delete(note);
        if (valueBox) {
          valueBox.classList.remove("field-flagged");
          valueBox.classList.add("field-ok");
        }
      }

      notesBox.value = Array.from(autoNotes).join("\\n");
    });
  });

  /* ===============================
     3) SECTION-LEVEL ❌ CHECKBOX
     ✅ THIS IS THE FIX
  =============================== */
  var sectionFixCheckboxes = document.querySelectorAll(
    'input[type="checkbox"][name="sections"]:not([disabled])'
  );

  function sectionHeading(section) {
    var map = {
      personal: "• Personal Information",
      course: "• Course Details",
      education: "• Educational Details",
      ids: "• ID Details",
      uploads: "• Uploads",
      center: "• Center Details",
      signatures: "• Signatures",
      other: "• Other Issues"
    };
    return map[section] || "• " + section;
  }

  sectionFixCheckboxes.forEach(function (chk) {
    chk.addEventListener("change", function () {
      var note = sectionHeading(chk.value);

      if (chk.checked) {
        autoNotes.add(note);
      } else {
        autoNotes.delete(note);
      }

      notesBox.value = Array.from(autoNotes).join("\\n");
    });
  });

});

// ✅ APPROVE LOADING FUNCTION
function showApproveLoading() {
  const overlay = document.getElementById('approve-loading-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
  }
}
</script>

<!-- ✅ APPROVE LOADING OVERLAY -->
<div id="approve-loading-overlay" style="display:none;position:fixed;inset:0;z-index:9999;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);">
  <div style="background:#fff;padding:30px 40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.2);text-align:center;">
    <div style="width:50px;height:50px;border:4px solid #e5e7eb;border-top-color:#16a34a;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px;"></div>
    <p style="font-weight:600;color:#374151;font-size:16px;margin:0;">Approving Admission...</p>
    <p style="color:#6b7280;font-size:13px;margin:8px 0 0 0;">Please wait while we process the approval</p>
  </div>
</div>

<style>
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>

</body>
</html>`;

    res.status(200).send(html);
  } catch (e) {
    console.error("reviewAdmissionPage failed:", e);
    res.status(500).send("<h2>Server error</h2>");

    
  }
}


/* ==================== REQUEST EDIT HANDLER (field-level) ==================== */
async function requestEditAdmission(req, res) {
  try {
    const { id } = req.params;

    // sections + notes ke alawa saare radio values "rest" me aa jayenge
    const { sections, notes, ...rest } = req.body;

    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).send("<h2>Admission not found</h2>");

    // selected sections (same as pehle)
    const sectionsArray = Array.isArray(sections)
      ? sections.filter(Boolean)
      : sections
      ? [sections]
      : [];

    // ✅ yahan se nikal rahe hai kaun-kaun se field pe ❌ (fix) laga
    const fieldFixKeys = Object.entries(rest)
      .filter(([_, v]) => typeof v === "string" && v === "fix")
      .map(([k]) => k);

    // single-use edit window me sections + fields dono store karo (in-memory)
    editPending.set(String(doc._id), {
      sections: sectionsArray,
      fields: fieldFixKeys,
      createdAt: Date.now(),
    });

    // 🔴 MongoDB me bhi last requested fields + notes store karo
    doc.editRequest = {
      ...(doc.editRequest || {}),
      sections: sectionsArray,
      fields: fieldFixKeys,
      notes: notes || "",
      status: "pending",
      createdAt: new Date(),
      resolvedAt: null,
    };
    await doc.save();

    console.log("📌 Request Edit for Admission", id, {
      sections: sectionsArray,
      fieldsNeedingFix: fieldFixKeys,
      notes,
      studentEmail: doc.personal?.email,
    });

    /* ======================
       1. Generate EDIT LINK
    ======================= */
  
const counselorKey = doc?.meta?.counselorKey === "c2" ? "c2" : "c1";

// base frontend url
// const base = (
//   process.env.PUBLIC_BASE_URL ||
//   process.env.CLIENT_ORIGIN ||
//   process.env.APP_BASE_URL ||
//   "http://localhost:3002"
// ).replace(/\/+$/, "");

const base = (
  process.env.CLIENT_ORIGIN ||
  process.env.APP_BASE_URL ||
  "http://localhost:3002"
).replace(/\/+$/, "");

// params
const sectionsParam = encodeURIComponent(JSON.stringify(sectionsArray));
const fieldsParam = encodeURIComponent(JSON.stringify(fieldFixKeys));

// ✅ FINAL EDIT LINK (c1 / c2 auto)
const editLink =
  `${base}/admission-form` +
  `?edit=1` +
  `&id=${doc._id}` +
  `&c=${counselorKey}` +
  `&sections=${sectionsParam}` +
  `&fields=${fieldsParam}`;

console.log("✏️ Student Edit Link:", editLink);


    /* ===================================
       2. Send EMAIL to the Student
    ==================================== */
    const mailHtml = `
      <div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
        <h2 style="margin:0 0 8px;color:#dc2626">Awdiz – Edit Required</h2>
        <p>Hi <b>${doc.personal?.name}</b>,</p>
        <p>Your admission form needs some corrections. Please update the highlighted fields.</p>

        ${notes ? `<p><b>Notes from Counselor:</b><br/>${notes}</p>` : ""}

        <p>
          <a href="${editLink}"
             style="background:#2563eb;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;"
             target="_blank">
             ✏️ Click here to Edit your Form
          </a>
        </p>

        <p style="margin-top:12px;font-size:12px;color:#6b7280">
          Only the fields marked with ❌ by the counselor will be editable.
        </p>
      </div>
    `.trim();

    // const mail = {
    //   from: {
    //     name: "Awdiz Admissions",
    //     address: process.env.FROM_EMAIL,
    //   },
    //   to: doc.personal?.email,
    //   subject: "Awdiz Admission – Edit Required",
    //   html: mailHtml,
    // };

    // ✅ counselor identity resolve (c1 / c2)


/* ===================================
   2. Send EMAIL to the Student (FINAL)
==================================== */

// ✅ counselor identity resolve (c1 / c2) + safe fallback
// helper: comma separated se first valid email nikalna
const pickFirstEmail = (val) =>
  String(val || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)[0];

// ✅ FROM email: FROM_EMAIL nahi hai to SMTP_USER use karo (industry standard)
const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;

// ✅ counselor resolve (ab EMAIL / EMAILS dono support)
const counselor =
  counselorKey === "c2"
    ? {
        name: process.env.COUNSELOR2_NAME || "NISHA",
        email:
          process.env.COUNSELOR2_EMAIL ||
          pickFirstEmail(process.env.COUNSELOR2_EMAILS) ||
          "", // blank allowed
      }
    : {
        name: process.env.COUNSELOR1_NAME || "MUDASSIR",
        email:
          process.env.COUNSELOR1_EMAIL ||
          pickFirstEmail(process.env.COUNSELOR1_EMAILS) ||
          "", // blank allowed
      };

// ✅ safe notes (avoid html injection)
const safeNotes = String(notes || "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;")
  .replaceAll("\n", "<br/>");

// ✅ FINAL MAIL HTML
const finalMailHtml = `
  <div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
    <h2 style="margin:0 0 8px;color:#dc2626">Awdiz – Edit Required</h2>
    <p>Hi <b>${doc.personal?.name || ""}</b>,</p>
    <p>Your admission form needs some corrections. Please update the highlighted fields.</p>

    ${notes ? `<p><b>Notes from Counselor:</b><br/>${safeNotes}</p>` : ""}

    <p>
      <a href="${editLink}"
         style="background:#2563eb;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;"
         target="_blank">
         ✏️ Click here to Edit your Form
      </a>
    </p>

    <p style="margin-top:12px;font-size:12px;color:#6b7280">
      Only the fields marked with ❌ by the counselor will be editable.
    </p>

    <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/>
    <p style="font-size:13px;color:#374151;margin:0">
      Counselor: <b>${counselor.name}</b><br/>
      Email: ${counselor.email || "-"}<br/>
      <span style="font-size:12px;color:#6b7280">(Reply to this email to reach your counselor directly)</span>
    </p>
  </div>
`.trim();


// ✅ guard: fromEmail must exist
if (!fromEmail) {
  console.warn("⚠️ FROM email missing. Set SMTP_USER (recommended) or FROM_EMAIL in .env");
}

// ✅ counselor email missing warn
if (!counselor.email) {
  console.warn(
    "⚠️ Counselor email missing. Check COUNSELOR1_EMAIL/COUNSELOR1_EMAILS or COUNSELOR2_EMAIL/COUNSELOR2_EMAILS"
  );
}

// ✅ build mail (NO undefined headers)
const mail = {
  from: `"${counselor.name} (Awdiz)" <${fromEmail}>`,
  to: doc.personal?.email,

  // reply kare to counselor ko hi jayega
  ...(counselor.email
    ? { replyTo: `"${counselor.name}" <${counselor.email}>` }
    : {}),

  subject: `Edit Required – ${doc.personal?.name || ""}`,
  html: finalMailHtml,
};


console.log("📤 Mail meta:", {
  to: mail.to,
  replyTo: mail.replyTo,
  from: mail.from,
});




await transporter.sendMail(mail);
console.log("📨 Edit request mail sent →", doc.personal?.email, {
  from: mail.from,
  replyTo: mail.replyTo,
});


    /* ===================================
       3. Return SUCCESS PAGE
    ==================================== */
    return res.status(200).send(`
      <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;margin:40px auto;
                  padding:24px;border-radius:12px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;">
        <h2 style="margin-top:0;color:#111827;">Edit Request Sent</h2>
        <p style="margin:8px 0 4px;">
          Email sent to <b>${doc.personal?.email}</b> with edit link.
        </p>
        <p style="margin:0 0 8px;font-size:14px;color:#374151;">
          Student can now edit only the fields marked with ❌.
        </p>
        <p style="margin:0;font-size:12px;color:#6b7280;">
          You can close this tab.
        </p>
      </div>
    `);
  } catch (e) {
    console.error("requestEditAdmission failed:", e);
    res.status(500).send("<h2>Server error</h2>");
  }
}
/* ==================== ADMIN → COUNSELOR EDIT REQUEST ==================== */
async function requestEditToCounselor(req, res) {
  try {
    const { id } = req.params;
    const { sections, notes, ...rest } = req.body;

    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).send("Admission not found");

    const sectionsArray = Array.isArray(sections)
      ? sections.filter(Boolean)
      : sections ? [sections] : [];

    const fieldFixKeys = Object.entries(rest)
      .filter(([_, v]) => v === "fix")
      .map(([k]) => k);

    doc.editRequest = {
      sections: sectionsArray,
      fields: fieldFixKeys,
      notes: notes || "",
      status: "admin-requested",
      createdAt: new Date(),
    };

    await doc.save();

    // mail try/catch (your existing block)...
    try {
      const { counselorKey, list: counselorEmails } = pickCounselorEmailsByKey(doc?.meta?.counselorKey);
      if (counselorEmails.length) {
        const serverBase = getServerBaseUrl();
        const reviewUrl = `${serverBase}/api/admissions/${doc._id}/review`;
        const studentName = doc?.personal?.name || "Student";
        const courseName  = doc?.course?.name || "Course";

        const safeNotes = String(notes || "")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
          .replace(/\n/g, "<br/>");

        const html = `
  <div style="font-family:system-ui,Arial,sans-serif;line-height:1.6">
    <h2 style="margin:0 0 8px;color:#dc2626">Admin requested corrections</h2>
    <p><b>Student:</b> ${studentName}</p>
    <p><b>Course:</b> ${courseName}</p>
    ${safeNotes ? `<p><b>Notes:</b><br/>${safeNotes}</p>` : ""}
    <p>
      <a href="${reviewUrl}" target="_blank"
         style="display:inline-block;background:#2563eb;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:700">
        🔍 Open Admission Review
      </a>
    </p>
  </div>
`.trim();// keep yours

        await transporter.sendMail({
          ...(process.env.FROM_EMAIL ? { from: { name: "Awdiz Admissions", address: process.env.FROM_EMAIL } } : {}),
          to: counselorEmails,
          subject: `Admin Requested Edit – ${studentName} (${courseName})`,
          html,
        });
      }
    } catch (e) {
      console.error("Admin→Counselor edit request mail failed:", e);
    }

    return res.send(`
      <h2>Edit Request Sent to Counselor</h2>
      <p>The counselor has been notified to fix the issues.</p>
    `);
  } catch (err) {
    console.error("requestEditToCounselor failed:", err);
    return res.status(500).send("Server error");
  }
}

/* ==================== GET DATA FOR EDIT ==================== */
async function getAdmissionForEdit(req, res) {
  try {
    const { id } = req.params;
    const { fields } = req.query; // URL se bhi fields aa sakte hai

    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).json({ message: "Admission not found" });

    // 🔴 Sirf tabhi allow karo jab editPending me entry ho
    const state = editPending.get(String(id));
    let allowedSections = Array.isArray(state?.sections) ? state.sections : [];
    let allowedFields = Array.isArray(state?.fields) ? state.fields : [];

    // 🔵 DATABASE FALLBACK: agar memory me nahi hai to DB se check karo
    if (!allowedSections.length) {
      const dbEditRequest = doc.editRequest;
      if (dbEditRequest?.status === "pending" && Array.isArray(dbEditRequest?.sections)) {
        allowedSections = dbEditRequest.sections;
        allowedFields = Array.isArray(dbEditRequest?.fields) ? dbEditRequest.fields : [];
        // 🔄 Restore to memory for consistency
        editPending.set(String(id), {
          sections: allowedSections,
          fields: allowedFields,
          createdAt: dbEditRequest.createdAt?.getTime() || Date.now(),
        });
      }
    }

    if (!allowedSections.length) {
      return res.status(400).json({
        message:
          "This edit link has expired or is not active. Please contact the counselor for a new edit request.",
      });
    }

    // fallback: agar kisi reason se memory me fields na ho lekin URL param hai
    if (!allowedFields.length && typeof fields === "string") {
      try {
        allowedFields = JSON.parse(fields);
      } catch {
        allowedFields = [];
      }
    }

    return res.status(200).json({
      admission: doc.toObject(),
      allowedSections,
      allowedFields, // 🔁 NEW
    });
  } catch (e) {
    console.error("getAdmissionForEdit failed:", e);
    res.status(500).json({ message: "Server error" });
  }
}

/* ==================== APPLY EDIT (STUDENT SUBMIT) ==================== */
async function applyAdmissionEdit(req, res) {
  try {
    const { id } = req.params;
    let { updated } = req.body || {}; // updated = full form data

    if (!id) {
      return res.status(400).json({ message: "Missing admission id" });
    }

    const doc = await Admission.findById(id);
    if (!doc) {
      return res.status(404).json({ message: "Admission not found" });
    }

    // 🔴 EDIT WINDOW CHECK (single-use)
    const state = editPending.get(String(id));
    let allowedSections = Array.isArray(state?.sections) ? state.sections : [];

    // 🔵 DATABASE FALLBACK: agar memory me nahi hai to DB se check karo
    if (!allowedSections.length) {
      const dbEditRequest = doc.editRequest;
      if (dbEditRequest?.status === "pending" && Array.isArray(dbEditRequest?.sections)) {
        allowedSections = dbEditRequest.sections;
        // 🔄 Restore to memory for consistency
        editPending.set(String(id), {
          sections: allowedSections,
          fields: Array.isArray(dbEditRequest?.fields) ? dbEditRequest.fields : [],
          createdAt: dbEditRequest.createdAt?.getTime() || Date.now(),
        });
      }
    }

    if (!allowedSections.length) {
      return res.status(400).json({
        success: false,
        message:
          "Edit window has expired. Please contact counselor for a new edit request.",
      });
    }

    // Parse updated JSON if it's a string
    if (typeof updated === "string") {
      try {
        updated = JSON.parse(updated);
      } catch (e) {
        console.error("Failed to parse updated JSON:", e);
        updated = {};
      }
    }

    updated = updated || {};

    // 💡 Sirf allowed sections update karenge – simple merge
    if (allowedSections.includes("personal") && updated.personal) {
      doc.personal = { ...(doc.personal || {}), ...(updated.personal || {}) };
    }

    if (allowedSections.includes("course") && updated.course) {
      doc.course = { ...(doc.course || {}), ...(updated.course || {}) };
    }

    if (allowedSections.includes("education") && Array.isArray(updated.education)) {
      doc.education = updated.education;
    }

    if (allowedSections.includes("ids") && updated.ids) {
      doc.ids = { ...(doc.ids || {}), ...(updated.ids || {}) };
    }

    if (allowedSections.includes("center") && updated.center) {
      doc.center = { ...(doc.center || {}), ...(updated.center || {}) };
    }

    if (allowedSections.includes("signatures") && updated.signatures) {
      // Check if student signature was updated with new data URL
      const newStudentSign = updated.signatures?.student?.signDataUrl;
      const oldStudentSign = doc.signatures?.student?.signDataUrl;
      const studentSignChanged = newStudentSign && newStudentSign !== oldStudentSign;
      
      // Check if parent signature was updated with new data URL
      const newParentSign = updated.signatures?.parent?.signDataUrl;
      const oldParentSign = doc.signatures?.parent?.signDataUrl;
      const parentSignChanged = newParentSign && newParentSign !== oldParentSign;
      
      doc.signatures = {
        ...(doc.signatures || {}),
        ...(updated.signatures || {}),
      };
      
      // Clear old Cloudinary URLs when new signatures are captured
      if (studentSignChanged) {
        doc.signatures.student = {
          ...doc.signatures.student,
          signUrl: "", // Clear old Cloudinary URL
        };
      }
      
      if (parentSignChanged) {
        doc.signatures.parent = {
          ...doc.signatures.parent,
          signUrl: "", // Clear old Cloudinary URL
        };
      }
    }

    // ✅ UPLOADS section: Handle new file uploads during edit
    if (allowedSections.includes("uploads")) {
      try {
        if (req.files?.photo?.[0]) {
          const r = await uploadStudentDoc({
            file: req.files.photo[0],
            folder: "awdiz/admissions/photos",
            publicIdPrefix: "photo",
          });
          // ✅ Also save data URL for PDF
          const photoDataUrl = await compressToJpegDataUrl(req.files.photo[0]);
          doc.uploads = { ...(doc.uploads || {}), photoUrl: r.url, photoKind: r.kind, photoDataUrl };
        }
      } catch (e) {
        console.log("Edit photo upload skipped:", e?.message);
      }

      try {
        if (req.files?.pan?.[0]) {
          const r = await uploadStudentDoc({
            file: req.files.pan[0],
            folder: "awdiz/admissions/pan",
            publicIdPrefix: "pan",
          });
          doc.uploads = { ...(doc.uploads || {}), panUrl: r.url, panKind: r.kind };
        }
      } catch (e) {
        console.log("Edit pan upload skipped:", e?.message);
      }

      try {
        if (req.files?.aadhaar?.[0]) {
          const r = await uploadStudentDoc({
            file: req.files.aadhaar[0],
            folder: "awdiz/admissions/aadhaar",
            publicIdPrefix: "aadhaar",
          });
          doc.uploads = { ...(doc.uploads || {}), aadhaarUrl: r.url, aadhaarKind: r.kind };
        }
      } catch (e) {
        console.log("Edit aadhaar upload skipped:", e?.message);
      }
    }

    // ✅ Edit ke baad status ko fir se "pending" rakhenge (counselor re-review karega)
    doc.status = "pending";
    await doc.save(); // 👈 pehle Mongo me latest data save

    // ✅ EditRequest metadata complete karo (resolved)
    doc.editRequest = {
      ...(doc.editRequest || {}),
      status: "completed",
      resolvedAt: new Date(),
    };
    await doc.save();

    /* ==============================
       🔁 1) Regenerate PENDING PDFs
    =============================== */
    let freshStudentUrl = "";
    let freshCounselorUrl = "";

    try {
      const basePayload = { ...doc.toObject(), status: "pending" };

      const freshStudentPdf = await generateAdmissionPDF(basePayload);
      const freshCounselorPdf = await generateAdmissionPDF(basePayload);

      freshStudentUrl = asUrl(freshStudentPdf);
      freshCounselorUrl = asUrl(freshCounselorPdf);

      if (!freshStudentUrl || !freshCounselorUrl) {
        throw new Error(
          "PDF service did not return URLs for edited pending PDFs."
        );
      }

      // 🔄 DB me nayi PDF URLs store karo
      doc.pdf = {
        ...(doc.pdf || {}),
        pendingStudentUrl: freshStudentUrl,
        pendingCounselorUrl: freshCounselorUrl,
      };
      await doc.save();

      console.log("📝 Edited pending PDFs regenerated:", {
        pendingStudentUrl: freshStudentUrl,
        pendingCounselorUrl: freshCounselorUrl,
      });
    } catch (pdfErr) {
      console.error("regenerate pending PDFs after edit failed:", pdfErr);
    }

    /* ==============================
       🔁 2) Google Sheet row UPDATE
    =============================== */
    try {
      const courseName = doc?.course?.name || "Admissions";

      // 🔥 EDIT ke baad ALWAYS full row update hogi
      await updateAdmissionRow(courseName, {
        ...doc.toObject(),
        admissionId: String(doc._id),
        status: "Pending",
        pdfUrl: freshStudentUrl || doc?.pdf?.pendingStudentUrl || "",
      });

      console.log("📊 Google Sheet updated after edit.");
    } catch (sheetErr) {
      console.error("Google Sheet update after edit failed:", sheetErr);
    }

    // 🔴 IMPORTANT: one-time use – ab ye edit link expire ho gaya
    editPending.delete(String(id));

    /* ==============================
       ✉️ Counselor ko EDIT mail bhejo
    =============================== */
//     try {
//       // const base = (
//       //   process.env.PUBLIC_BASE_URL ||
//       //   process.env.APP_BASE_URL ||
//       //   "http://localhost:5002"
//       // ).replace(/\/+$/, "");

//       // const reviewUrl = `${base}/api/admissions/${doc._id}/review`;

//       // ✅ EDIT ke baad counselor ko FRONTEND review page dena hai
// const base = (
//   process.env.APP_BASE_URL ||        // production frontend
//   process.env.CLIENT_ORIGIN ||       // localhost:3002
//   "http://localhost:3002"
// ).replace(/\/+$/, "");

// const reviewUrl = `${base}/admissions/${doc._id}/review`;


//       // const counselorList = (process.env.COUNSELOR_EMAILS || "")
//       //   .split(",")
//       //   .map((e) => e.trim())
//       //   .filter(Boolean);

//       // const to = counselorList.length ? counselorList : [process.env.FROM_EMAIL];

//       await sendCounselorMail({
//   payload: {
//     ...doc.toObject(),
//     originalCounselorKey: doc.meta?.counselorKey,
//   },

//   // 🔥 LOCAL = NO PDF URL (avoid 404 fetch)
//   counselorPdfUrl: process.env.CLOUDINARY_CLOUD_NAME
//     ? doc?.pdf?.pendingCounselorUrl
//     : null,
// });


//       const studentName = doc.personal?.name || "Student";
//       const courseName = doc.course?.name || "Course";

//       const html = `
//         <div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
//           <h2 style="margin:0 0 8px;color:#16a34a;">Awdiz – Edited Admission Submitted</h2>
//           <p>
//             Student <b>${studentName}</b> has updated the admission form
//             for course <b>${courseName}</b>.
//           </p>
//           <p style="margin:8px 0;">
//             Please review the updated details and approve or request further changes if needed.
//           </p>
//           <p style="margin:14px 0;">
//             <a href="${reviewUrl}"
//                style="background:#2563eb;color:#ffffff;padding:10px 16px;border-radius:6px;
//                       text-decoration:none;font-weight:600;"
//                target="_blank">
//               🔍 Open Updated Admission
//             </a>
//           </p>
//           <p style="margin-top:12px;font-size:12px;color:#6b7280;">
//             This mail was sent automatically after the student clicked "Save changes" on the edit link.
//           </p>
//         </div>
//       `.trim();

//       const mail = {
//         from: {
//           name: "Awdiz Admissions",
//           address: process.env.FROM_EMAIL,
//         },
//         to,
//         subject: `Edited Admission – ${studentName} (${courseName})`,
//         html,
//       };

//       await transporter.sendMail(mail);
//       // console.log("📧 Counselor EDIT notification mail sent →", to);
//       console.log("📧 Counselor EDIT notification mail sent via sendCounselorMail()");
//     } catch (mailErr) {
//       console.error("send counselor EDIT mail failed:", mailErr);
//     }



/* ==============================
   ✉️ Counselor ko RESUBMISSION mail (EDITED)
=============================== */
try {
  const key = doc?.meta?.counselorKey; // "c1" or "c2"
  const { counselorKey, list: counselorEmails } = pickCounselorEmailsByKey(key);

  if (!counselorEmails.length) {
    console.warn(
      `⚠️ No counselor emails found for ${counselorKey}. Skipping resubmission mail.`
    );
  } else {
    const serverBase = getServerBaseUrl();
    const reviewUrl = `${serverBase}/api/admissions/${doc._id}/review`;

    const studentName = doc?.personal?.name || "Student";
    const courseName = doc?.course?.name || "Course";

    const pdfUrl =
      doc?.pdf?.pendingCounselorUrl ||
      doc?.pdf?.pendingStudentUrl ||
      "";

    const html = `
      <div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
        <h2 style="margin:0 0 8px;color:#16a34a;">
          Awdiz – Student Resubmitted After Corrections
        </h2>

        <p>
          Student <b>${studentName}</b> has <b>resubmitted</b> the admission form after making the requested corrections
          for <b>${courseName}</b>.
        </p>

        <p style="margin:14px 0;">
          <a href="${reviewUrl}"
             style="background:#2563eb;color:#ffffff;padding:10px 16px;border-radius:8px;
                    text-decoration:none;font-weight:700"
             target="_blank">
            🔍 Open Updated Admission (Review)
          </a>
        </p>

        ${
          pdfUrl
            ? `<p style="margin:10px 0 0">PDF Link: <a href="${pdfUrl}" target="_blank">Open PDF</a></p>`
            : ``
        }

        <p style="margin-top:12px;font-size:12px;color:#6b7280;">
          Counselor: <b>${String(counselorKey || "").toUpperCase()}</b>
          &nbsp;|&nbsp; Note: This is a resubmission (not a new admission).
        </p>
      </div>
    `.trim();

    const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;

    // replyTo counselor (first email from EMAIL/EMAILS)
    const firstEmail = (v) =>
      String(v || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)[0] || "";

    const counselorReplyTo =
      counselorKey === "c2"
        ? (process.env.COUNSELOR2_EMAIL || firstEmail(process.env.COUNSELOR2_EMAILS))
        : (process.env.COUNSELOR1_EMAIL || firstEmail(process.env.COUNSELOR1_EMAILS));

    const mail = {
      ...(fromEmail ? { from: `"Awdiz Admissions" <${fromEmail}>` } : {}),
      to: counselorEmails,
      subject: `Edited Admission Resubmitted – ${studentName} (${courseName})`,
      html,
      ...(counselorReplyTo ? { replyTo: counselorReplyTo } : {}),
    };

    await transporter.sendMail(mail);

    console.log("📨 Resubmission mail sent to counselor →", counselorEmails, {
      counselorKey,
      replyTo: counselorReplyTo || null,
    });
  }
} catch (mailErr) {
  console.error("❌ Counselor resubmission mail failed:", mailErr);
}

    return res.status(200).json({
      success: true,
      message:
        "Admission updated successfully. Counselor will review the changes.",
      id: doc._id,
    });
  } catch (e) {
    console.error("applyAdmissionEdit failed:", e);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: e.message });
  }
}



/* ==================== NAMED EXPORTS ==================== */
export {
  initAdmission,
  dummyVerifyAdmissionOtp,
  reviewAdmissionPage,
  adminReviewAdmissionPage,
  requestEditAdmission,
  requestEditToCounselor,
  submitToAdmin,
  approveAdmission,
  getAdmissionForEdit,
  applyAdmissionEdit,
};
