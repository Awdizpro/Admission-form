// server/src/controllers/admission.otp.controller.js

import PendingAdmission from "../models/PendingAdmission.js";
import Admission from "../models/Admission.js";
import { uploadBuffer } from "../services/storage.service.js";
import { sendOtpSms } from "../services/sms.service.js";
import { generateAdmissionPDF } from "../services/pdf.service.js";
import {
  sendAdmissionEmails,
  sendOtpEmail,
  sendCounselorMail, // ✅ NOW ENABLED (needs email.service.js updated)
} from "../services/email.service.js";
import { generateOtp, hashOtp, verifyOtp } from "../services/otp.service.js";

const toBool = (v) => v === true || v === "true" || v === 1 || v === "1";

// ✅ normalize any pdf service return (string / object)
const asUrl = (x) =>
  typeof x === "string" ? x : x?.secure_url || x?.url || x?.pdfUrl || "";

// ✅ safer uploads: ek fail ho to baaki na rukhe
async function pickUploads(req) {
  const safeUpload = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error("upload skipped:", e?.message || e);
      return undefined;
    }
  };

  return Promise.all([
    // photo
    safeUpload(async () => {
      const f = req.files?.photo?.[0];
      if (!f) return undefined;
      const r = await uploadBuffer({
        buffer: f.buffer,
        folder: "awdiz/admissions/photos",
        publicId: `photo-${Date.now()}`,
        resource_type: "image",
      });
      return r?.secure_url;
    }),

    // pan
    safeUpload(async () => {
      const f = req.files?.pan?.[0];
      if (!f) return undefined;
      const r = await uploadBuffer({
        buffer: f.buffer,
        folder: "awdiz/admissions/pan",
        publicId: `pan-${Date.now()}`,
        resource_type: "raw",
        extra: { format: "pdf" },
      });
      return r?.secure_url;
    }),

    // aadhaar
    safeUpload(async () => {
      const f = req.files?.aadhaar?.[0];
      if (!f) return undefined;
      const r = await uploadBuffer({
        buffer: f.buffer,
        folder: "awdiz/admissions/aadhaar",
        publicId: `aadhaar-${Date.now()}`,
        resource_type: "raw",
        extra: { format: "pdf" },
      });
      return r?.secure_url;
    }),
  ]);
}

async function dataUrlToPng(dataUrl, publicId) {
  const b64 = dataUrl.split(",")[1];
  const buf = Buffer.from(b64, "base64");
  const r = await uploadBuffer({
    buffer: buf,
    folder: "awdiz/admissions/signatures",
    publicId,
    resource_type: "image",
    extra: { format: "png" },
  });
  return r?.secure_url;
}

/* ===========================
   STEP 1: INIT (MOBILE + EMAIL)
=========================== */
export async function initAdmission(req, res) {
  try {
    let body = {};
    try {
      body = JSON.parse(req.body.payload || "{}");
    } catch {
      return res.status(400).json({ message: "Invalid form payload" });
    }

    // ✅ minimal validation (align with frontend OtpVerify.jsx)
    if (
      !body?.personal?.name ||
      !body?.personal?.studentMobile ||
      !body?.personal?.email ||
      !body?.course?.name ||
      !toBool(body?.termsAccepted)
    ) {
      return res
        .status(400)
        .json({ message: "Please complete all required fields and accept T&C." });
    }

    // ✅ if you want Data Consent required:
    if (body?.dataConsentAccepted === false) {
      return res.status(400).json({ message: "Please accept Data Consent." });
    }

    const [photoUrl, panUrl, aadhaarUrl] = await pickUploads(req);

    // ✅ signatures optional/required: keep as-is (no strict failure here)
    let studentSignUrl, parentSignUrl;

    if (req.body.studentSignDataUrl?.startsWith("data:image")) {
      studentSignUrl = await dataUrlToPng(
        req.body.studentSignDataUrl,
        `student-sign-${Date.now()}`
      );
    }

    if (req.body.parentSignDataUrl?.startsWith("data:image")) {
      parentSignUrl = await dataUrlToPng(
        req.body.parentSignDataUrl,
        `parent-sign-${Date.now()}`
      );
    }

    // ✅ counselorKey support (IMPORTANT: default should be counselor1/counselor2)
    const counselorKeyRaw =
      body?.meta?.counselorKey ||
      body?.counselorKey ||
      req.body?.counselorKey ||
      "counselor1";

    // map short keys -> canonical
    const counselorKey =
      counselorKeyRaw === "c1" || counselorKeyRaw === "sheet1" || counselorKeyRaw === "1"
        ? "counselor1"
        : counselorKeyRaw === "c2" || counselorKeyRaw === "sheet2" || counselorKeyRaw === "2"
        ? "counselor2"
        : counselorKeyRaw;

    const payload = {
      ...body,
      personal: {
        ...body.personal,
        name: String(body.personal.name || "").trim(),
        studentMobile: String(body.personal.studentMobile || "").trim(),
        email: String(body.personal.email || "").trim(),
      },
      course: {
        ...body.course,
        enrolled: toBool(body?.course?.enrolled ?? true),
      },
      uploads: { photoUrl, panUrl, aadhaarUrl },
      signatures: {
        ...body.signatures,
        student: { ...body.signatures?.student, signUrl: studentSignUrl || null },
        parent: { ...body.signatures?.parent, signUrl: parentSignUrl || null },
      },
      tc: {
        accepted: true,
        version: body.tcVersion || "2025-10-16",
        text: body.tcText || "",
        type: body?.course?.trainingOnly ? "training-only" : "job-guarantee",
        dataConsentAccepted: !!(
          body?.dataConsentAccepted || body?.tc?.dataConsentAccepted
        ),
      },
      // ✅ counselorKey must exist at top-level too (easy access everywhere)
      counselorKey,
      meta: {
        ...(body.meta || {}),
        counselorKey,
        planType: body?.course?.trainingOnly ? "training" : "job",
      },
    };

    /* ==================== 2 OTPs ==================== */
    const fixed = process.env.OTP_ALWAYS;
    const mobileOtp = fixed || generateOtp(6);
    const emailOtp = fixed || generateOtp(6);

    const mobileOtpHash = hashOtp(mobileOtp);
    const emailOtpHash = hashOtp(emailOtp);

    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    const pending = await PendingAdmission.create({
      mobile: payload.personal.studentMobile,
      email: payload.personal.email,
      payload,
      uploads: {
        photoUrl,
        panUrl,
        aadhaarUrl,
        signatures: { studentSignUrl, parentSignUrl },
      },

      mobileOtpHash,
      emailOtpHash,
      mobileVerified: false,
      emailVerified: false,

      otpExpiresAt,
      status: "PENDING",
      attempts: 0,
    });

    // 🔹 SMS: mobile OTP
    try {
      await sendOtpSms(payload.personal.studentMobile, mobileOtp);
    } catch (e) {
      console.error("sendOtpSms failed:", e?.message || e);
    }

    // 🔹 Email: email OTP
    try {
      await sendOtpEmail({
        to: payload.personal.email,
        name: payload.personal.name,
        otp: emailOtp,
      });
    } catch (e) {
      console.error("sendOtpEmail failed:", e?.message || e);
    }

    if (String(process.env.SMS_DUMMY || "true") === "true") {
      console.log("🧪 Mobile OTP for testing:", mobileOtp);
      console.log("🧪 Email OTP for testing:", emailOtp);
      console.log("🧩 counselorKey saved in payload:", counselorKey);
    }

    return res.status(200).json({
      pendingId: pending._id,
      message: "Mobile & Email OTP sent",
    });
  } catch (e) {
    console.error("initAdmission failed:", e);
    return res.status(500).json({ message: "Server error" });
  }
}

/* ===========================
   STEP 2: VERIFY (channel: mobile/email)
=========================== */
export async function verifyAdmission(req, res) {
  try {
    const { pendingId, otp, channel } = req.body;

    if (!pendingId || !otp) {
      return res
        .status(400)
        .json({ message: "pendingId and otp are required" });
    }

    const ch = String(channel || "").toLowerCase();
    if (!ch || !["mobile", "email"].includes(ch)) {
      return res.status(400).json({ message: "Invalid channel" });
    }

    const pending = await PendingAdmission.findOne({ _id: pendingId });
    if (!pending || pending.status !== "PENDING") {
      return res.status(404).json({ message: "Session not found/expired" });
    }

    if (pending.otpExpiresAt < new Date()) {
      pending.status = "EXPIRED";
      await pending.save();
      return res.status(400).json({ message: "OTP expired" });
    }

    // ✅ allow dev master otp
    const devMaster = process.env.DEV_MASTER_OTP || "000000";

    let ok = false;
    if (otp === devMaster) ok = true;
    else if (ch === "mobile") ok = verifyOtp(otp, pending.mobileOtpHash);
    else if (ch === "email") ok = verifyOtp(otp, pending.emailOtpHash);

    if (!ok) {
      pending.attempts += 1;
      await pending.save();
      return res.status(400).json({ message: "Invalid OTP" });
    }

    /* --------- MOBILE STEP --------- */
    if (ch === "mobile") {
      if (pending.mobileVerified) {
        return res.status(200).json({ message: "Mobile already verified" });
      }
      pending.mobileVerified = true;
      await pending.save();

      return res.status(200).json({
        message: "Mobile OTP verified. Please verify Email OTP now.",
        step: "mobile-verified",
      });
    }

    /* --------- EMAIL STEP --------- */
    if (ch === "email") {
      if (!pending.mobileVerified) {
        return res
          .status(400)
          .json({ message: "Please verify Mobile OTP first." });
      }

      // if repeat verify
      if (pending.emailVerified && pending.finalAdmissionId) {
        return res.status(200).json({
          message: "Email already verified",
          id: pending.finalAdmissionId,
        });
      }

      pending.emailVerified = true;
      pending.status = "VERIFIED";
      await pending.save();

      const payload = pending.payload || {};
      const counselorKey =
        payload?.counselorKey || payload?.meta?.counselorKey || "counselor1";

      // ✅ Create PENDING PDFs
      // const studentPdf = await generateAdmissionPDF({
      //   ...payload,
      //   status: "pending",
      // });
      // ✅ Create PENDING PDF (ONLY ONCE)
const counselorPdf = await generateAdmissionPDF({
  ...payload,
  status: "pending",
});

// ✅ same PDF used for db + counselor
const pendingStudentUrl = asUrl(counselorPdf);
const pendingCounselorUrl = pendingStudentUrl;

if (!pendingStudentUrl) {
  return res.status(500).json({ message: "PDF generation failed" });
}

      // ✅ Save final Admission as PENDING (and persist counselorKey at root too)
      const saved = await Admission.create({
        ...payload,
        counselorKey,
        status: "pending",
        pdf: {
          pendingStudentUrl,
          pendingCounselorUrl,
        },
        meta: {
          ...payload.meta,
          pendingId: pendingId, // Store pendingId for status checking
        },
      });

      // ✅ store finalAdmissionId (for retry responses)
      pending.finalAdmissionId = saved._id;
      await pending.save();

      // // ✅ Student mail
      await sendAdmissionEmails({
        studentEmail: payload?.personal?.email,
        // pdfBuffer: studentPdf?.buffer, // if exists
        // pdfFileName: `Awdiz-Admission-${saved._id}.pdf`,
        // pdfUrl: pendingStudentUrl,
        payload: { ...payload, status: "pending", _id: saved._id },
      });

 

      // ✅ Counselor mail (AUTO ROUTE by counselorKey + admin BCC)
      // email.service.js v3 will route:
      // counselor1 -> COUNSELOR1_EMAILS
      // counselor2 -> COUNSELOR2_EMAILS
      await sendCounselorMail({
        payload: {
          ...payload,
          _id: saved._id,
          status: "pending",
          counselorKey, // ✅ must be present
        },
        counselorPdfUrl: pendingCounselorUrl,
        pdfBuffer: counselorPdf?.buffer,
        pdfFileName: `Awdiz-Admission-Pending-${saved._id}.pdf`,
        // no to/bcc here => routing + ADMIN_EMAILS handled by service
      });

      // ✅ delete pending record (session cleanup)
      await PendingAdmission.deleteOne({ _id: pending._id });

      return res.status(201).json({
        message: "Verified & Submitted (Pending Approval)",
        id: saved._id,
      });
    }
  } catch (e) {
    console.error("verifyAdmission failed:", e);
    return res.status(500).json({ message: "Server error" });
  }
}

/* ===========================
   CHECK STATUS: Check if admission was successful
   =========================== */
export async function checkAdmissionStatus(req, res) {
  try {
    const { pendingId } = req.params;

    if (!pendingId) {
      return res.status(400).json({ message: "pendingId is required" });
    }

    // Check if admission exists for this pendingId
    const admission = await Admission.findOne({ 
      "meta.pendingId": pendingId 
    }).sort({ createdAt: -1 });

    if (admission) {
      return res.status(200).json({
        success: true,
        id: admission._id,
        pdfUrl: admission.pdf?.pendingStudentUrl || admission.pdf?.approvedStudentUrl || null,
        status: admission.status,
        message: "Admission found"
      });
    }

    // Check if pending record still exists
    const pending = await PendingAdmission.findById(pendingId);
    if (!pending) {
      return res.status(404).json({ 
        success: false, 
        message: "No pending record found" 
      });
    }

    return res.status(200).json({
      success: false,
      status: pending.status,
      message: "Admission not yet completed"
    });

  } catch (e) {
    console.error("checkAdmissionStatus failed:", e);
    return res.status(500).json({ message: "Server error" });
  }
}
