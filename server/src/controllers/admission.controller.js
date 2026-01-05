// // server/src/controllers/admission.controller.js

// import sharp from "sharp";
// import Admission from "../models/Admission.js";
// import { uploadBuffer } from "../services/storage.service.js";
// import { generateAdmissionPDF } from "../services/pdf.service.js"; // returns { buffer, url, ... }
// import {
//   sendAdmissionEmails,
//   sendCounselorMail,
//   transporter,
//   sendOtpEmail, // 🔹 NEW: email OTP
// } from "../services/email.service.js";
// import {
//   appendAdmissionRow,
//   setAdmissionStatus,
//   updateAdmissionRow,
// } from "../services/sheets.service.js";
// import { sendOtpSms } from "../services/sms.service.js"; // 🔹 NEW: SMS OTP
// import { generateOtp, hashOtp, verifyOtp } from "../services/otp.service.js"; // 🔹 NEW: OTP utils

// // normalize any pdf-service return into a URL string
// const asUrl = (x) => (typeof x === "string" ? x : x?.secure_url || x?.url || "");

// // in-memory pending OTP store
// // pendingId -> { payload, mobile, email, mobileOtpHash, emailOtpHash, mobileVerified, emailVerified, createdAt, expiresAt }
// const pending = new Map();

// // counselor → student edit window (single-use)
// // admissionId -> { sections, fields, createdAt }
// const editPending = new Map();

// const toBool = (v, d = true) => {
//   if (v === true || v === "true" || v === 1 || v === "1") return true;
//   if (v === false || v === "false" || v === 0 || v === "0") return false;
//   return d;
// };

// // Convert uploaded image -> compact JPEG data URL
// async function compressToJpegDataUrl(file, maxW = 600, maxH = 600, q = 80) {
//   if (!file) return null;
//   try {
//     let buf = await sharp(file.buffer)
//       .resize({
//         width: maxW,
//         height: maxH,
//         fit: "inside",
//         withoutEnlargement: true,
//       })
//       .jpeg({ quality: q })
//       .toBuffer();

//     if (buf.length > 2 * 1024 * 1024) {
//       buf = await sharp(buf).jpeg({ quality: 60 }).toBuffer();
//     }

//     return `data:image/jpeg;base64,${buf.toString("base64")}`;
//   } catch (e) {
//     console.error("compressToJpegDataUrl failed:", e?.message);
//     return null;
//   }
// }

// const tryPickDataUrl = (v) =>
//   typeof v === "string" && v.startsWith("data:image") ? v : null;

// /* ==================== INIT ADMISSION ==================== */
// async function initAdmission(req, res) {
//   try {
//     const body = JSON.parse(req.body.payload || "{}");

//     // ✅ NEW: counselorKey resolve here (req/body available here only)
//     const counselorKey =
//       String(
//         req.query?.c ||
//           body?.counselorKey ||
//           body?.meta?.counselorKey ||
//           body?.course?.counselorKey ||
//           "c1"
//       )
//         .trim()
//         .toLowerCase() === "c2"
//         ? "c2"
//         : "c1";

//     if (
//       !body?.personal?.name ||
//       !body?.personal?.studentMobile ||
//       !body?.personal?.email ||
//       (!body?.course?.name && !body?.course?.trainingOnlyCourse) ||
//       body?.termsAccepted !== true
//     ) {
//       return res.status(400).json({
//         message:
//           "Please complete all required fields and accept Terms & Conditions.",
//       });
//     }

//     // Upload files
//     let photoUrl, panUrl, aadhaarUrl;

//     try {
//       if (req.files?.photo?.[0]) {
//         const up = await uploadBuffer({
//           buffer: req.files.photo[0].buffer,
//           folder: "awdiz/admissions/photos",
//           publicId: `photo-${Date.now()}`,
//           resource_type: "image",
//         });
//         photoUrl = up?.secure_url;
//       }
//     } catch (e) {
//       console.log("photo upload skipped:", e?.message);
//     }

//     try {
//       if (req.files?.pan?.[0]) {
//         const up = await uploadBuffer({
//           buffer: req.files.pan[0].buffer,
//           folder: "awdiz/admissions/pan",
//           publicId: `pan-${Date.now()}`,
//           resource_type: "raw",
//         });
//         panUrl = up?.secure_url;
//       }
//     } catch (e) {
//       console.log("pan upload skipped:", e?.message);
//     }

//     try {
//       if (req.files?.aadhaar?.[0]) {
//         const up = await uploadBuffer({
//           buffer: req.files.aadhaar[0].buffer,
//           folder: "awdiz/admissions/aadhaar",
//           publicId: `aadhaar-${Date.now()}`,
//           resource_type: "raw",
//         });
//         aadhaarUrl = up?.secure_url;
//       }
//     } catch (e) {
//       console.log("aadhaar upload skipped:", e?.message);
//     }

//     // Data URLs for PDF (photo/pan/aadhaar)
//     const photoDataUrl = await compressToJpegDataUrl(req.files?.photo?.[0]);
//     const panDataUrl = await compressToJpegDataUrl(req.files?.pan?.[0]);
//     const aadhaarDataUrl = await compressToJpegDataUrl(req.files?.aadhaar?.[0]);

//     /* ---------- Signatures (data URLs only; NO student->parent fallback) ---------- */
//     const studentSignDataUrl =
//       tryPickDataUrl(req.body?.studentSignDataUrl) ||
//       tryPickDataUrl(body?.files?.studentSign) ||
//       tryPickDataUrl(body?.signatures?.student?.signDataUrl) ||
//       null;

//     const parentSignDataUrl =
//       tryPickDataUrl(req.body?.parentSignDataUrl) ||
//       tryPickDataUrl(body?.files?.parentSign) ||
//       tryPickDataUrl(body?.signatures?.parent?.signDataUrl) ||
//       null;

//     // Quick debug
//     const _studLen = (studentSignDataUrl || "").length;
//     const _parLen = (parentSignDataUrl || "").length;
//     console.log("[SIG] student(len):", _studLen, " parent(len):", _parLen);

//     // STRICT: Parent/Guardian sign is mandatory (no fallback)
//     if (!_parLen) {
//       return res.status(400).json({
//         message:
//           "Parent/Guardian signature is required (data URL missing or too large).",
//         hint: "Ensure field name is 'parentSignDataUrl' and increase multer fieldSize to 10MB.",
//       });
//     }

//     const payload = {
//       ...body,
//       personal: {
//         ...body.personal,
//         name: String(body.personal.name || "").trim(),
//         studentMobile: String(body.personal.studentMobile || "").trim(),
//         email: String(body.personal.email || "").trim(),
//       },
//       course: { ...body.course, enrolled: toBool(body?.course?.enrolled, true) },
//       uploads: {
//         photoUrl,
//         panUrl,
//         aadhaarUrl,
//         photoDataUrl,
//         panDataUrl,
//         aadhaarDataUrl,
//       },
//       signatures: {
//         ...body.signatures,
//         student: {
//           ...(body.signatures?.student || {}),
//           signDataUrl:
//             body.signatures?.student?.signDataUrl || studentSignDataUrl || null,
//           signUrl: body.signatures?.student?.signUrl || studentSignDataUrl || null,
//         },
//         parent: {
//           ...(body.signatures?.parent || {}),
//           signDataUrl:
//             body.signatures?.parent?.signDataUrl || parentSignDataUrl || null,
//           signUrl: body.signatures?.parent?.signUrl || parentSignDataUrl || null,
//         },
//       },
//       tc: {
//         accepted: true,
//         version: body.tcVersion || "",
//         text: body.tcText || "",
//         type: body.course.trainingOnly ? "training-only" : "job-guarantee",
//       },
//       meta: {
//         planType: body.course.trainingOnly ? "training" : "job",
//         counselorKey, // ✅ NEW (stored in DB)
//       },
//     };

//     /* ==================== 2-OTP GENERATION ==================== */
//     // (ENV OTP_ALWAYS ho to dono me wahi use hoga)
//     const mobileOtpRaw = process.env.OTP_ALWAYS || generateOtp(6);
//     const emailOtpRaw = process.env.OTP_ALWAYS || generateOtp(6);

//     const mobileOtpHash = hashOtp(mobileOtpRaw);
//     const emailOtpHash = hashOtp(emailOtpRaw);

//     const pendingId = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;

//     const now = Date.now();
//     const ttlMs = 15 * 60 * 1000; // 15 minutes

//     pending.set(pendingId, {
//       payload,
//       mobile: payload.personal.studentMobile,
//       email: payload.personal.email,
//       mobileOtpHash,
//       emailOtpHash,
//       mobileVerified: false,
//       emailVerified: false,
//       createdAt: now,
//       expiresAt: now + ttlMs,
//     });

//     // 📨 SEND MOBILE OTP (SMS)
//     try {
//       await sendOtpSms(payload.personal.studentMobile, mobileOtpRaw);
//     } catch (err) {
//       console.error("sendOtpSms failed:", err?.message || err);
//     }

//     // 📨 SEND EMAIL OTP
//     try {
//       await sendOtpEmail({
//         to: payload.personal.email,
//         name: payload.personal.name,
//         otp: emailOtpRaw,
//       });
//     } catch (err) {
//       console.error("sendOtpEmail failed:", err?.message || err);
//     }

//     // DEV log
//     if (String(process.env.SMS_DUMMY || "true") === "true") {
//       console.log("🧪 DEV Mobile OTP:", mobileOtpRaw);
//       console.log("🧪 DEV Email  OTP:", emailOtpRaw);
//     }

//     return res.status(200).json({
//       pendingId,
//       message: "Mobile & Email OTP sent.",
//     });
//   } catch (e) {
//     console.error("initAdmission failed:", e);
//     return res.status(500).json({ message: "Server error" });
//   }
// }

// /* ==================== VERIFY (2-STEP OTP) ==================== */
// async function dummyVerifyAdmissionOtp(req, res) {
//   try {
//     const { pendingId, otp } = req.body || {};

//     if (!pendingId || !otp) {
//       return res
//         .status(400)
//         .json({ message: "pendingId and otp are required" });
//     }

//     const item = pending.get(pendingId);
//     if (!item) {
//       return res
//         .status(400)
//         .json({ message: "Session expired or invalid pendingId" });
//     }

//     // expiry check
//     if (item.expiresAt && Date.now() > item.expiresAt) {
//       pending.delete(pendingId);
//       return res.status(400).json({ message: "OTP session expired" });
//     }

//     const devMaster = process.env.DEV_MASTER_OTP || "000000";

//     /* --------- STEP 1: MOBILE OTP --------- */
//     if (!item.mobileVerified) {
//       const ok =
//         otp === devMaster ||
//         (item.mobileOtpHash && verifyOtp(otp, item.mobileOtpHash));

//       if (!ok) {
//         return res.status(400).json({ message: "Invalid Mobile OTP" });
//       }

//       item.mobileVerified = true;
//       pending.set(pendingId, item);

//       return res.status(200).json({
//         message: "Mobile OTP verified. Please enter Email OTP.",
//         step: "mobile-verified",
//         next: "email",
//       });
//     }

//     /* --------- STEP 2: EMAIL OTP --------- */
//     if (!item.emailVerified) {
//       const ok =
//         otp === devMaster ||
//         (item.emailOtpHash && verifyOtp(otp, item.emailOtpHash));

//       if (!ok) {
//         return res.status(400).json({ message: "Invalid Email OTP" });
//       }

//       item.emailVerified = true;
//       pending.set(pendingId, item);

//       // ✅ Now BOTH verified → FINALIZE ADMISSION (same as old dummyVerify logic)
//       const p = { ...item.payload, status: "pending" };

//       // PDFs (buffer + url)
//       const studentPdf = await generateAdmissionPDF({ ...p, status: "pending" });
//       const counselorPdf = await generateAdmissionPDF({ ...p, status: "pending" });

//       const pendingStudentUrl = asUrl(studentPdf);
//       const pendingCounselorUrl = asUrl(counselorPdf);

//       if (!pendingStudentUrl || !pendingCounselorUrl) {
//         throw new Error("PDF service did not return URL for pending PDFs.");
//       }

//       // Save PENDING in DB
//       const saved = await Admission.create({
//         ...p,
//         pdf: { pendingStudentUrl, pendingCounselorUrl },
//         education: (p.education || []).map((ed) => ({
//           qualification: ed.qualification || "",
//           school: ed.school || "",
//           year: ed.year || "",
//           percentage: ed.percentage || "",
//         })),
//       });

//       // ✅ GOOGLE SHEET: append PENDING row (AdmissionID = saved._id)
//       try {
//         const courseName = p?.course?.name || "Admissions";
//         await appendAdmissionRow(courseName, {
//           ...p,
//           pdfUrl: pendingStudentUrl,
//           admissionId: String(saved._id),
//           status: "Pending",
//           counselorKey: p?.meta?.counselorKey, // ✅ NEW
//         });
//       } catch (err) {
//         console.error("❌ Google Sheet (pending append) failed:", err?.message);
//       }

//       // Mail student (attachment + link)
//       await sendAdmissionEmails({
//         studentEmail: p.personal.email,
//         pdfBuffer: studentPdf.buffer,
//         pdfFileName: `Awdiz-Admission-${saved._id}.pdf`,
//         pdfUrl: pendingStudentUrl,
//         payload: p,
//       });

//       // Mail counselor (attachment + review link button)
//       await sendCounselorMail({
//         payload: { ...p, _id: saved._id },
//         counselorPdfUrl: pendingCounselorUrl,
//         pdfBuffer: counselorPdf.buffer,
//         pdfFileName: `Awdiz-Admission-Pending-${saved._id}.pdf`,
//       });

//       pending.delete(pendingId);
//       return res.status(200).json({
//         message: "Admission Submitted – Pending Approval",
//         id: saved._id,
//         pdfUrl: pendingStudentUrl,
//         step: "completed",
//       });
//     }

//     // If both already verified:
//     return res.status(200).json({
//       message: "Already verified.",
//       step: "completed",
//     });
//   } catch (e) {
//     console.error("dummyVerifyAdmissionOtp failed:", e);
//     return res.status(500).json({ message: "Server error" });
//   }
// }

// /* ==================== APPROVE (ADMIN/COUNSELOR) ==================== */
// async function approveAdmission(req, res) {
//   try {
//     const { id } = req.params;
//     const doc = await Admission.findById(id);
//     if (!doc) return res.status(404).send("<h2>Not found</h2>");

//     // ✅ ALWAYS use counselorKey stored in DB (reliable)
//     const counselorKey =
//       String(doc?.meta?.counselorKey || "c1").trim().toLowerCase() === "c2"
//         ? "c2"
//         : "c1";

//     // Generate Approved PDF
//     const approvedPdf = await generateAdmissionPDF({
//       ...doc.toObject(),
//       status: "approved",
//     });
//     const approvedUrl = asUrl(approvedPdf);
//     if (!approvedUrl) {
//       throw new Error("PDF service did not return URL for approved PDF.");
//     }

//     // Update DB
//     doc.status = "approved";
//     doc.pdf = { ...(doc.pdf || {}), approvedUrl };
//     await doc.save();

//     // ✅ Flip Google Sheet row (same AdmissionID = Mongo _id)
//     try {
//       await setAdmissionStatus(
//         doc?.center?.placeOfAdmission || "",
//         doc?.course?.name || "Admissions",
//         String(doc._id),
//         "Approved",
//         { approvedPdfUrl: approvedUrl, counselorKey } // ✅ NEW (clean)
//       );
//     } catch (err) {
//       console.error("❌ Google Sheet status flip failed:", err?.message);
//     }

//     // Mail student with Approved PDF attached
//     await sendAdmissionEmails({
//       studentEmail: doc.personal.email,
//       pdfBuffer: approvedPdf.buffer,
//       pdfFileName: `Awdiz-Admission-Approved-${doc._id}.pdf`,
//       pdfUrl: approvedUrl,
//       payload: { ...doc.toObject(), status: "approved" },
//     });

//     // Success Page for Counselor
//     const logo =
//       process.env.AWDIZ_LOGO_URL ||
//       "https://res.cloudinary.com/www-awdiz-in/image/upload/v1675932002/logo/awdiz.png";
//     const studentName = doc.personal?.name || "Student";
//     const courseName = doc.course?.name || "Course";

//     res.status(200).send(`
//       <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;margin:50px auto;padding:32px;border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;text-align:center;">
//         <img src="${logo}" alt="Awdiz" style="height:48px;margin-bottom:16px"/>
//         <h2 style="color:#16a34a;margin:8px 0;">✅ Admission Approved Successfully</h2>
//         <p style="font-size:16px;margin:12px 0 8px;">The admission for <b>${studentName}</b> (${courseName}) has been approved.</p>
//         <p style="margin:0 0 16px;">A confirmation email with the approved PDF has been sent to the student.</p>
//         <p><a href="${approvedUrl}" target="_blank" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">📄 Open Approved PDF</a></p>
//         <p style="font-size:13px;color:#6b7280;margin-top:20px;">You can safely close this window after verifying the email delivery.</p>
//       </div>
//     `);
//   } catch (e) {
//     console.error("approveAdmission failed:", e);
//     res.status(500).send("<h2>Server error</h2>");
//   }
// }

// /* ==================== COUNSELOR REVIEW PAGE (HTML) ==================== */
// async function reviewAdmissionPage(req, res) {
//   try {
//     const { id } = req.params;
//     const doc = await Admission.findById(id);
//     if (!doc) return res.status(404).send("<h2>Admission not found</h2>");

//     const p = doc.toObject();

//     // 🔴 LAST REQUESTED FIELDS (jo counselor ne ❌ mark kiye the)
//     const editReq = p.editRequest || {};
//     const flaggedFields = Array.isArray(editReq.fields) ? editReq.fields : [];
//     const lastNotes = editReq.notes || "";

//     const pdfUrl =
//       p?.pdf?.pendingCounselorUrl ||
//       p?.pdf?.pendingStudentUrl ||
//       p?.pdf?.approvedUrl ||
//       p?.pdfUrl ||
//       "";

//     const eduRows =
//       (p.education || []).length > 0
//         ? (p.education || [])
//             .map(
//               (ed, idx) => `
//             <tr>
//               <td>${idx + 1}</td>
//               <td>${ed.qualification || "-"}</td>
//               <td>${ed.school || "-"}</td>
//               <td>${ed.year || "-"}</td>
//               <td>${ed.percentage || "-"}</td>
//             </tr>`
//             )
//             .join("")
//         : `<tr><td colspan="5" style="padding:6px 8px;font-size:13px;color:#6b7280;">No education details filled.</td></tr>`;

//     const jobType = p?.course?.trainingOnly
//       ? "No Job Guarantee – Training only"
//       : "Job Guarantee Training";

//     const html = `<!DOCTYPE html>
// <html lang="en">
// <head>
//   <meta charset="UTF-8" />
//   <title>Awdiz Admission Review – ${p.personal?.name || ""}</title>
//   <style>
//     * { box-sizing: border-box; }
//     body {
//       font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
//       background:#e5e7eb;
//       margin:0;
//       padding:24px 12px;
//     }
//     .page {
//       max-width: 1080px;
//       margin:0 auto;
//       background:#f9fafb;
//       border-radius:12px;
//       border:1px solid #e5e7eb;
//       padding:20px;
//     }
//     .header {
//       display:flex;
//       justify-content:space-between;
//       align-items:center;
//       margin-bottom:14px;
//     }
//     .title {
//       font-size:20px;
//       font-weight:600;
//       margin:0;
//     }
//     .subtitle {
//       font-size:13px;
//       color:#6b7280;
//       margin-top:4px;
//     }
//     .pdf-pane {
//       border:1px solid #e5e7eb;
//       border-radius:10px;
//       overflow:hidden;
//       background:#111827;
//       margin-bottom:16px;
//     }
//     .pdf-pane-header {
//       display:flex;
//       justify-content:space-between;
//       align-items:center;
//       padding:10px 14px;
//       background:#111827;
//       color:#f9fafb;
//       font-size:13px;
//     }
//     .pdf-frame {
//       width:100%;
//       height:480px;
//       border:0;
//       background:#111827;
//     }
//     .btn-inline {
//       display:inline-flex;
//       align-items:center;
//       gap:6px;
//       font-size:13px;
//       padding:6px 10px;
//       border-radius:999px;
//       border:1px solid #4b5563;
//       color:#e5e7eb;
//       text-decoration:none;
//       background:transparent;
//     }
//     .btn-inline span.icon { font-size:15px; }

//     form#review-form {
//       margin-top:4px;
//     }
//     .section-card {
//       background:#ffffff;
//       border-radius:10px;
//       border:1px solid #e5e7eb;
//       padding:14px 16px;
//       margin-top:10px;
//     }
//     .sec-header {
//       display:flex;
//       justify-content:space-between;
//       align-items:flex-start;
//       margin-bottom:8px;
//       gap:8px;
//     }
//     .sec-title {
//       font-size:14px;
//       font-weight:600;
//       margin:0;
//     }
//     .sec-badges {
//       display:flex;
//       gap:8px;
//       font-size:12px;
//     }
//     .badge {
//       display:inline-flex;
//       align-items:center;
//       gap:4px;
//       padding:2px 8px;
//       border-radius:999px;
//       border:1px solid #d1d5db;
//       background:#f9fafb;
//       color:#374151;
//     }
//     .badge input {
//       margin:0;
//     }
//     .grid-2 {
//       display:grid;
//       grid-template-columns:repeat(2,minmax(0,1fr));
//       gap:8px 16px;
//       font-size:13px;
//     }
//     .field-label {
//       font-size:12px;
//       text-transform:uppercase;
//       letter-spacing:.04em;
//       color:#6b7280;
//       margin-bottom:2px;
//     }
//     .field-value {
//       font-size:13px;
//       color:#111827;
//       padding:4px 6px;
//       border-radius:6px;
//       background:#f9fafb;
//       border:1px dashed #e5e7eb;
//       min-height:26px;
//     }
//     .field-flagged {
//       border-color:#ef4444;
//       background:#fef2f2;
//       color:#b91c1c;
//     }
//     table.edu {
//       width:100%;
//       border-collapse:collapse;
//       font-size:12px;
//       margin-top:4px;
//     }
//     .edu th, .edu td {
//       border:1px solid #e5e7eb;
//       padding:4px 6px;
//       text-align:left;
//     }
//     .edu th {
//       background:#f3f4f6;
//       font-weight:600;
//     }
//     .notes-box {
//       width:100%;
//       min-height:70px;
//       border-radius:8px;
//       border:1px solid #d1d5db;
//       padding:8px 10px;
//       font-size:13px;
//       resize:vertical;
//     }
//     .actions-row {
//       display:flex;
//       flex-wrap:wrap;
//       gap:10px;
//       margin-top:14px;
//       align-items:center;
//     }
//     .btn-primary {
//       border:none;
//       border-radius:999px;
//       padding:10px 18px;
//       font-size:14px;
//       font-weight:600;
//       cursor:pointer;
//       display:inline-flex;
//       align-items:center;
//       gap:8px;
//       background:#f97316;
//       color:#ffffff;
//     }
//     .btn-primary:hover { background:#ea580c; }
//     .btn-success {
//       border:none;
//       border-radius:999px;
//       padding:10px 18px;
//       font-size:14px;
//       font-weight:600;
//       cursor:pointer;
//       display:inline-flex;
//       align-items:center;
//       gap:8px;
//       background:#16a34a;
//       color:#ffffff;
//       text-decoration:none;
//     }
//     .btn-success:hover { background:#15803d; }
//     .btn-ghost {
//       border-radius:999px;
//       padding:8px 14px;
//       font-size:13px;
//       display:inline-flex;
//       align-items:center;
//       gap:8px;
//       border:1px solid #e5e7eb;
//       background:#ffffff;
//       color:#111827;
//       text-decoration:none;
//       cursor:pointer;
//     }
//     .helper {
//       margin-top:6px;
//       font-size:12px;
//       color:#6b7280;
//     }

//     /* ==== NEW for per-field flags ==== */
//     .field-row {
//       display:flex;
//       align-items:flex-start;
//       gap:8px;
//       margin-bottom:8px;
//     }
//     .field-main {
//       flex:1 1 auto;
//     }
//     .field-flags {
//       display:flex;
//       flex-direction:row;
//       gap:4px;
//       align-items:center;
//       font-size:11px;
//       white-space:nowrap;
//     }
//     .mini-badge {
//       display:inline-flex;
//       align-items:center;
//       gap:2px;
//       padding:1px 6px;
//       border-radius:999px;
//       border:1px solid #d1d5db;
//       background:#f9fafb;
//       color:#374151;
//     }
//     .mini-badge input {
//       margin:0;
//     }
//     .hidden-section-checkbox {
//       display:none;
//     }

//     @media (max-width:768px){
//       .grid-2 { grid-template-columns:1fr; }
//       .pdf-frame { height:380px; }
//     }
//   </style>
// </head>
// <body>
//   <div class="page">
//     <div class="header">
//       <div>
//         <h1 class="title">Awdiz Admission Review</h1>
//         <p class="subtitle">
//           Student: <b>${p.personal?.name || "-"}</b> &middot; Course: <b>${p.course?.name || "-"}</b>
//         </p>
//       </div>
//     </div>

//     <!-- PDF preview -->
//     <div class="pdf-pane">
//       <div class="pdf-pane-header">
//         <div>Pending Admission PDF</div>
//         <div>
//           ${
//             pdfUrl
//               ? `<a class="btn-inline" href="${pdfUrl}" target="_blank"><span class="icon">📄</span><span>Open PDF in new tab</span></a>`
//               : `<span style="font-size:12px;color:#9ca3af;">No PDF URL found</span>`
//           }
//         </div>
//       </div>
//       ${
//         pdfUrl
//           ? `<iframe class="pdf-frame" src="${pdfUrl}"></iframe>`
//           : `<div style="padding:18px;font-size:13px;color:#9ca3af;">PDF not available.</div>`
//       }
//     </div>

//     <!-- REVIEW FORM -->
//     <form id="review-form" method="POST" action="/api/admissions/${doc._id}/request-edit">

//       <!-- PERSONAL (field-wise flags) -->
//       <div class="section-card">
//         <div class="sec-header">
//           <p class="sec-title">Personal Information</p>
//         </div>

//         <!-- hidden master checkbox for backend -->
//         <input
//           type="checkbox"
//           name="sections"
//           value="personal"
//           data-section-master="personal"
//           class="hidden-section-checkbox"
//         />

//         <div class="grid-2">
//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Full Name</div>
//               <div class="field-value${
//                 flaggedFields.includes("pf_fullName") ? " field-flagged" : ""
//               }">${p.personal?.salutation || ""} ${p.personal?.name || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="pf_fullName" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="pf_fullName" value="fix" data-section="personal" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Father / Guardian Name</div>
//               <div class="field-value${
//                 flaggedFields.includes("pf_guardian") ? " field-flagged" : ""
//               }">${p.personal?.fatherOrGuardianName || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="pf_guardian" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="pf_guardian" value="fix" data-section="personal" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Address</div>
//               <div class="field-value${
//                 flaggedFields.includes("pf_address") ? " field-flagged" : ""
//               }">${p.personal?.address || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="pf_address" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="pf_address" value="fix" data-section="personal" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Student Mobile</div>
//               <div class="field-value${
//                 flaggedFields.includes("pf_studentMobile") ? " field-flagged" : ""
//               }">${p.personal?.studentMobile || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="pf_studentMobile" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="pf_studentMobile" value="fix" data-section="personal" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">WhatsApp Mobile</div>
//               <div class="field-value${
//                 flaggedFields.includes("pf_whatsapp") ? " field-flagged" : ""
//               }">${p.personal?.whatsappMobile || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="pf_whatsapp" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="pf_whatsapp" value="fix" data-section="personal" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Parent Mobile</div>
//               <div class="field-value${
//                 flaggedFields.includes("pf_parentMobile") ? " field-flagged" : ""
//               }">${p.personal?.parentMobile || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="pf_parentMobile" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="pf_parentMobile" value="fix" data-section="personal" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Email</div>
//               <div class="field-value${
//                 flaggedFields.includes("pf_email") ? " field-flagged" : ""
//               }">${p.personal?.email || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="pf_email" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="pf_email" value="fix" data-section="personal" />
//                 ❌
//               </label>
//             </div>
//           </div>
//         </div>
//       </div>

//       <!-- COURSE (same as before) -->
//       <div class="section-card">
//         <div class="sec-header">
//           <p class="sec-title">Course Details</p>
//           <div class="sec-badges">
//             <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
//             <label class="badge"><input type="checkbox" name="sections" value="course" /> ❌ Needs correction</label>
//           </div>
//         </div>
//         <div class="grid-2">
//           <div>
//             <div class="field-label">Course Name</div>
//             <div class="field-value">${p.course?.name || "-"}</div>
//           </div>
//           <div>
//             <div class="field-label">Reference</div>
//             <div class="field-value">${p.course?.reference || "-"}</div>
//           </div>
//           <div>
//             <div class="field-label">Plan Type</div>
//             <div class="field-value">${jobType}</div>
//           </div>
//         </div>
//       </div>

//       <!-- EDUCATION (same) -->
//       <div class="section-card">
//         <div class="sec-header">
//           <p class="sec-title">Educational Details</p>
//           <div class="sec-badges">
//             <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
//             <label class="badge"><input type="checkbox" name="sections" value="education" /> ❌ Needs correction</label>
//           </div>
//         </div>
//         <table class="edu">
//           <thead>
//             <tr>
//               <th>#</th>
//               <th>Qualification</th>
//               <th>School / College</th>
//               <th>Year</th>
//               <th>% Marks</th>
//             </tr>
//           </thead>
//           <tbody>${eduRows}</tbody>
//         </table>
//       </div>

//       <!-- IDS (same) -->
//       <div class="section-card">
//         <div class="sec-header">
//           <p class="sec-title">ID Details</p>
//           <div class="sec-badges">
//             <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
//             <label class="badge"><input type="checkbox" name="sections" value="ids" /> ❌ Needs correction</label>
//           </div>
//         </div>
//         <div class="grid-2">
//           <div>
//             <div class="field-label">PAN Number</div>
//             <div class="field-value">${p.ids?.pan || "-"}</div>
//           </div>
//           <div>
//             <div class="field-label">Aadhaar / Driving</div>
//             <div class="field-value">${p.ids?.aadhaarOrDriving || "-"}</div>
//           </div>
//         </div>
//       </div>

//       <!-- UPLOADS (field-wise flags, master = "uploads") -->
//       <div class="section-card">
//         <div class="sec-header">
//           <p class="sec-title">Uploads</p>
//         </div>

//         <input
//           type="checkbox"
//           name="sections"
//           value="uploads"
//           data-section-master="uploads"
//           class="hidden-section-checkbox"
//         />

//         <div class="grid-2">
//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Passport Photo</div>
//               <div class="field-value${
//                 flaggedFields.includes("up_photo") ? " field-flagged" : ""
//               }">${p.uploads?.photoUrl || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="up_photo" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="up_photo" value="fix" data-section="uploads" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">PAN</div>
//               <div class="field-value${
//                 flaggedFields.includes("up_pan") ? " field-flagged" : ""
//               }">${p.uploads?.panUrl || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="up_pan" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="up_pan" value="fix" data-section="uploads" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Aadhaar</div>
//               <div class="field-value${
//                 flaggedFields.includes("up_aadhaar") ? " field-flagged" : ""
//               }">${p.uploads?.aadhaarUrl || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="up_aadhaar" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="up_aadhaar" value="fix" data-section="uploads" />
//                 ❌
//               </label>
//             </div>
//           </div>
//         </div>
//       </div>

//       <!-- CENTER (same) -->
//       <div class="section-card">
//         <div class="sec-header">
//           <p class="sec-title">Center Details</p>
//           <div class="sec-badges">
//             <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
//             <label class="badge"><input type="checkbox" name="sections" value="center" /> ❌ Needs correction</label>
//           </div>
//         </div>
//         <div class="grid-2">
//           <div>
//             <div class="field-label">Place of Admission</div>
//             <div class="field-value">${p.center?.placeOfAdmission || "-"}</div>
//           </div>
//           <div>
//             <div class="field-label">Mode</div>
//             <div class="field-value">${p.center?.mode || "-"}</div>
//           </div>
//         </div>
//       </div>

//       <!-- SIGNATURES (field-wise flags) -->
//       <div class="section-card">
//         <div class="sec-header">
//           <p class="sec-title">Signatures</p>
//         </div>

//         <input
//           type="checkbox"
//           name="sections"
//           value="signatures"
//           data-section-master="signatures"
//           class="hidden-section-checkbox"
//         />

//         <div class="grid-2">
//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Student Name</div>
//               <div class="field-value${
//                 flaggedFields.includes("sg_student") ? " field-flagged" : ""
//               }">${p.signatures?.student?.fullName || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="sg_student" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="sg_student" value="fix" data-section="signatures" />
//                 ❌
//               </label>
//             </div>
//           </div>

//           <div class="field-row">
//             <div class="field-main">
//               <div class="field-label">Parent / Guardian Name</div>
//               <div class="field-value${
//                 flaggedFields.includes("sg_parent") ? " field-flagged" : ""
//               }">${p.signatures?.parent?.fullName || "-"}</div>
//             </div>
//             <div class="field-flags">
//               <label class="mini-badge">
//                 <input type="radio" name="sg_parent" value="ok" checked />
//                 ✅
//               </label>
//               <label class="mini-badge">
//                 <input type="radio" name="sg_parent" value="fix" data-section="signatures" />
//                 ❌
//               </label>
//             </div>
//           </div>
//         </div>
//       </div>

//       <!-- NOTES -->
//       <div class="section-card">
//         <div class="sec-header">
//           <p class="sec-title">Notes to Student (optional)</p>
//           <div class="sec-badges">
//             <label class="badge"><input type="checkbox" name="sections" value="other" /> ❌ Other issue</label>
//           </div>
//         </div>
//         <textarea name="notes" class="notes-box" placeholder="Example: Please correct spelling of your name and upload a clearer Aadhaar scan.">${lastNotes}</textarea>
//         <p class="helper">Jo sections yahan ❌ select karenge, unhi ko baad me student ke form me editable rakha jaa sakta hai.</p>
//       </div>

//       <div class="actions-row">
//         <button type="submit" class="btn-primary">
//           <span>✏️ Request Edit from Student</span>
//         </button>

//         <a href="/api/admissions/${doc._id}/approve" class="btn-success">
//           <span>✅ Admission Approved</span>
//         </a>

//         ${
//           pdfUrl
//             ? `<a href="${pdfUrl}" target="_blank" class="btn-ghost"><span>📄</span><span>Open PDF in new tab</span></a>`
//             : ""
//         }
//       </div>
//     </form>
//   </div>

//   <script>
//     document.addEventListener("DOMContentLoaded", function () {
//       // ==== 1) Section master auto-toggle (existing logic) ====
//       const radios = document.querySelectorAll('input[type="radio"][data-section]');
//       const sectionToRadios = {};

//       radios.forEach(function (r) {
//         const sec = r.getAttribute("data-section");
//         if (!sectionToRadios[sec]) sectionToRadios[sec] = [];
//         sectionToRadios[sec].push(r);
//       });

//       Object.keys(sectionToRadios).forEach(function (sec) {
//         const master = document.querySelector('input[data-section-master="' + sec + '"]');
//         if (!master) return;

//         const update = function () {
//           const anyBad = sectionToRadios[sec].some(function (r) {
//             return r.checked && r.value === "fix";
//           });
//           master.checked = anyBad;
//         };

//         sectionToRadios[sec].forEach(function (r) {
//           r.addEventListener("change", update);
//         });

//         // initial state
//         update();
//       });

//       // ==== 2) Auto-notes generation in "notes" textarea ====
//       const notesBox = document.querySelector('textarea[name="notes"]');
//       if (!notesBox) return;

//       const autoNotes = new Set();

//       radios.forEach(function (radio) {
//         radio.addEventListener("change", function () {
//           const fieldKey = radio.name;

//           const fieldLabel = fieldKey
//             .replace("pf_", "Personal: ")
//             .replace("up_", "Upload: ")
//             .replace("sg_", "Signature: ")
//             .replace(/([A-Z])/g, " $1")
//             .replace(/_/g, " ")
//             .trim();

//           const note = "• " + fieldLabel + " is missing or incorrect.";

//           if (radio.value === "fix") {
//             autoNotes.add(note);
//             notesBox.value = Array.from(autoNotes).join("\\n");
//           }

//           if (radio.value === "ok") {
//             if (autoNotes.has(note)) {
//               autoNotes.delete(note);
//               notesBox.value = Array.from(autoNotes).join("\\n");
//             }
//           }
//         });
//       });
//     });
//   </script>
// </body>
// </html>`;

//     res.status(200).send(html);
//   } catch (e) {
//     console.error("reviewAdmissionPage failed:", e);
//     res.status(500).send("<h2>Server error</h2>");
//   }
// }

// /* ==================== REQUEST EDIT HANDLER (field-level) ==================== */
// async function requestEditAdmission(req, res) {
//   try {
//     const { id } = req.params;

//     // sections + notes ke alawa saare radio values "rest" me aa jayenge
//     const { sections, notes, ...rest } = req.body;

//     const doc = await Admission.findById(id);
//     if (!doc) return res.status(404).send("<h2>Admission not found</h2>");

//     // selected sections (same as pehle)
//     const sectionsArray = Array.isArray(sections)
//       ? sections.filter(Boolean)
//       : sections
//       ? [sections]
//       : [];

//     // ✅ yahan se nikal rahe hai kaun-kaun se field pe ❌ (fix) laga
//     const fieldFixKeys = Object.entries(rest)
//       .filter(([_, v]) => typeof v === "string" && v === "fix")
//       .map(([k]) => k);

//     // single-use edit window me sections + fields dono store karo (in-memory)
//     editPending.set(String(doc._id), {
//       sections: sectionsArray,
//       fields: fieldFixKeys,
//       createdAt: Date.now(),
//     });

//     // 🔴 MongoDB me bhi last requested fields + notes store karo
//     doc.editRequest = {
//       ...(doc.editRequest || {}),
//       sections: sectionsArray,
//       fields: fieldFixKeys,
//       notes: notes || "",
//       status: "pending",
//       createdAt: new Date(),
//       resolvedAt: null,
//     };
//     await doc.save();

//     console.log("📌 Request Edit for Admission", id, {
//       sections: sectionsArray,
//       fieldsNeedingFix: fieldFixKeys,
//       notes,
//       studentEmail: doc.personal?.email,
//     });

//     /* ======================
//        1. Generate EDIT LINK
//     ======================= */
//     const base = (process.env.APP_BASE_URL || "http://localhost:5173").replace(
//       /\/+$/,
//       ""
//     );

//     const sectionsParam = encodeURIComponent(JSON.stringify(sectionsArray));
//     const fieldsParam = encodeURIComponent(JSON.stringify(fieldFixKeys));

//     const editLink = `${base}/admission-form?edit=1&id=${doc._id}&sections=${sectionsParam}&fields=${fieldsParam}`;

//     console.log("✏️ Edit Link:", editLink);

//     /* ===================================
//        2. Send EMAIL to the Student
//     ==================================== */
//     const mailHtml = `
//       <div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
//         <h2 style="margin:0 0 8px;color:#dc2626">Awdiz – Edit Required</h2>
//         <p>Hi <b>${doc.personal?.name}</b>,</p>
//         <p>Your admission form needs some corrections. Please update the highlighted fields.</p>

//         ${notes ? `<p><b>Notes from Counselor:</b><br/>${notes}</p>` : ""}

//         <p>
//           <a href="${editLink}"
//              style="background:#2563eb;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;"
//              target="_blank">
//              ✏️ Click here to Edit your Form
//           </a>
//         </p>

//         <p style="margin-top:12px;font-size:12px;color:#6b7280">
//           Only the fields marked with ❌ by the counselor will be editable.
//         </p>
//       </div>
//     `.trim();

//     const mail = {
//       from: {
//         name: "Awdiz Admissions",
//         address: process.env.FROM_EMAIL,
//       },
//       to: doc.personal?.email,
//       subject: "Awdiz Admission – Edit Required",
//       html: mailHtml,
//     };

//     await transporter.sendMail(mail);
//     console.log("📨 Edit request mail sent →", doc.personal?.email);

//     /* ===================================
//        3. Return SUCCESS PAGE
//     ==================================== */
//     return res.status(200).send(`
//       <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;margin:40px auto;
//                   padding:24px;border-radius:12px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;">
//         <h2 style="margin-top:0;color:#111827;">Edit Request Sent</h2>
//         <p style="margin:8px 0 4px;">
//           Email sent to <b>${doc.personal?.email}</b> with edit link.
//         </p>
//         <p style="margin:0 0 8px;font-size:14px;color:#374151;">
//           Student can now edit only the fields marked with ❌.
//         </p>
//         <p style="margin:0;font-size:12px;color:#6b7280;">
//           You can close this tab.
//         </p>
//       </div>
//     `);
//   } catch (e) {
//     console.error("requestEditAdmission failed:", e);
//     res.status(500).send("<h2>Server error</h2>");
//   }
// }

// /* ==================== GET DATA FOR EDIT ==================== */
// async function getAdmissionForEdit(req, res) {
//   try {
//     const { id } = req.params;
//     const { fields } = req.query; // URL se bhi fields aa sakte hai

//     const doc = await Admission.findById(id);
//     if (!doc) return res.status(404).json({ message: "Admission not found" });

//     // 🔴 Sirf tabhi allow karo jab editPending me entry ho
//     const state = editPending.get(String(id));
//     const allowedSections = Array.isArray(state?.sections) ? state.sections : [];

//     if (!allowedSections.length) {
//       return res.status(400).json({
//         message:
//           "This edit link has expired or is not active. Please contact the counselor for a new edit request.",
//       });
//     }

//     // 👉 field-level list
//     let allowedFields = Array.isArray(state?.fields) ? state.fields : [];

//     // fallback: agar kisi reason se memory me fields na ho lekin URL param hai
//     if (!allowedFields.length && typeof fields === "string") {
//       try {
//         allowedFields = JSON.parse(fields);
//       } catch {
//         allowedFields = [];
//       }
//     }

//     return res.status(200).json({
//       admission: doc.toObject(),
//       allowedSections,
//       allowedFields, // 🔁 NEW
//     });
//   } catch (e) {
//     console.error("getAdmissionForEdit failed:", e);
//     res.status(500).json({ message: "Server error" });
//   }
// }

// /* ==================== APPLY EDIT (STUDENT SUBMIT) ==================== */
// async function applyAdmissionEdit(req, res) {
//   try {
//     const { id } = req.params;
//     let { updated } = req.body || {}; // updated = full form data

//     if (!id) {
//       return res.status(400).json({ message: "Missing admission id" });
//     }

//     const doc = await Admission.findById(id);
//     if (!doc) {
//       return res.status(404).json({ message: "Admission not found" });
//     }

//     // 🔴 EDIT WINDOW CHECK (single-use)
//     const state = editPending.get(String(id));
//     const allowedSections = Array.isArray(state?.sections) ? state.sections : [];

//     if (!allowedSections.length) {
//       return res.status(400).json({
//         success: false,
//         message:
//           "Edit window has expired. Please contact counselor for a new edit request.",
//       });
//     }

//     updated = updated || {};

//     // 💡 Sirf allowed sections update karenge – simple merge
//     if (allowedSections.includes("personal") && updated.personal) {
//       doc.personal = { ...(doc.personal || {}), ...(updated.personal || {}) };
//     }

//     if (allowedSections.includes("course") && updated.course) {
//       doc.course = { ...(doc.course || {}), ...(updated.course || {}) };
//     }

//     if (allowedSections.includes("education") && Array.isArray(updated.education)) {
//       doc.education = updated.education;
//     }

//     if (allowedSections.includes("ids") && updated.ids) {
//       doc.ids = { ...(doc.ids || {}), ...(updated.ids || {}) };
//     }

//     if (allowedSections.includes("center") && updated.center) {
//       doc.center = { ...(doc.center || {}), ...(updated.center || {}) };
//     }

//     if (allowedSections.includes("signatures") && updated.signatures) {
//       doc.signatures = {
//         ...(doc.signatures || {}),
//         ...(updated.signatures || {}),
//       };
//     }

//     // ✅ Edit ke baad status ko fir se "pending" rakhenge (counselor re-review karega)
//     doc.status = "pending";
//     await doc.save(); // 👈 pehle Mongo me latest data save

//     // ✅ EditRequest metadata complete karo (resolved)
//     doc.editRequest = {
//       ...(doc.editRequest || {}),
//       status: "completed",
//       resolvedAt: new Date(),
//     };
//     await doc.save();

//     /* ==============================
//        🔁 1) Regenerate PENDING PDFs
//     =============================== */
//     let freshStudentUrl = "";
//     let freshCounselorUrl = "";

//     try {
//       const basePayload = { ...doc.toObject(), status: "pending" };

//       const freshStudentPdf = await generateAdmissionPDF(basePayload);
//       const freshCounselorPdf = await generateAdmissionPDF(basePayload);

//       freshStudentUrl = asUrl(freshStudentPdf);
//       freshCounselorUrl = asUrl(freshCounselorPdf);

//       if (!freshStudentUrl || !freshCounselorUrl) {
//         throw new Error(
//           "PDF service did not return URLs for edited pending PDFs."
//         );
//       }

//       // 🔄 DB me nayi PDF URLs store karo
//       doc.pdf = {
//         ...(doc.pdf || {}),
//         pendingStudentUrl: freshStudentUrl,
//         pendingCounselorUrl: freshCounselorUrl,
//       };
//       await doc.save();

//       console.log("📝 Edited pending PDFs regenerated:", {
//         pendingStudentUrl: freshStudentUrl,
//         pendingCounselorUrl: freshCounselorUrl,
//       });
//     } catch (pdfErr) {
//       console.error("regenerate pending PDFs after edit failed:", pdfErr);
//     }

//     /* ==============================
//        🔁 2) Google Sheet row UPDATE
//     =============================== */
//     try {
//       const courseName = doc?.course?.name || "Admissions";

//       // 🔥 EDIT ke baad ALWAYS full row update hogi
//       await updateAdmissionRow(courseName, {
//         ...doc.toObject(),
//         admissionId: String(doc._id),
//         status: "Pending",
//         pdfUrl: freshStudentUrl || doc?.pdf?.pendingStudentUrl || "",
//       });

//       console.log("📊 Google Sheet updated after edit.");
//     } catch (sheetErr) {
//       console.error("Google Sheet update after edit failed:", sheetErr);
//     }

//     // 🔴 IMPORTANT: one-time use – ab ye edit link expire ho gaya
//     editPending.delete(String(id));

//     /* ==============================
//        ✉️ Counselor ko EDIT mail bhejo
//     =============================== */
//     try {
//       const base = (
//         process.env.PUBLIC_BASE_URL ||
//         process.env.APP_BASE_URL ||
//         "http://localhost:5000"
//       ).replace(/\/+$/, "");

//       const reviewUrl = `${base}/api/admissions/${doc._id}/review`;

//       const counselorList = (process.env.COUNSELOR_EMAILS || "")
//         .split(",")
//         .map((e) => e.trim())
//         .filter(Boolean);

//       const to = counselorList.length ? counselorList : [process.env.FROM_EMAIL];

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
//       console.log("📧 Counselor EDIT notification mail sent →", to);
//     } catch (mailErr) {
//       console.error("send counselor EDIT mail failed:", mailErr);
//     }

//     return res.status(200).json({
//       success: true,
//       message:
//         "Admission updated successfully. Counselor will review the changes.",
//       id: doc._id,
//     });
//   } catch (e) {
//     console.error("applyAdmissionEdit failed:", e);
//     return res
//       .status(500)
//       .json({ success: false, message: "Server error", error: e.message });
//   }
// }

// /* ==================== NAMED EXPORTS ==================== */
// export {
//   initAdmission,
//   dummyVerifyAdmissionOtp,
//   reviewAdmissionPage,
//   requestEditAdmission,
//   approveAdmission,
//   getAdmissionForEdit,
//   applyAdmissionEdit,
// };


//try 

// server/src/controllers/admission.controller.js

import sharp from "sharp";
import Admission from "../models/Admission.js";
import { uploadBuffer } from "../services/storage.service.js";
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
const asUrl = (x) => (typeof x === "string" ? x : x?.secure_url || x?.url || "");

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

// Convert uploaded image -> compact JPEG data URL
async function compressToJpegDataUrl(file, maxW = 600, maxH = 600, q = 80) {
  if (!file) return null;
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

    // ✅ NEW: counselorKey resolve here (req/body available here only)
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

    // Upload files
    let photoUrl, panUrl, aadhaarUrl;

    try {
      if (req.files?.photo?.[0]) {
        const up = await uploadBuffer({
          buffer: req.files.photo[0].buffer,
          folder: "awdiz/admissions/photos",
          publicId: `photo-${Date.now()}`,
          resource_type: "image",
        });
        photoUrl = up?.secure_url;
      }
    } catch (e) {
      console.log("photo upload skipped:", e?.message);
    }

    try {
      if (req.files?.pan?.[0]) {
        const up = await uploadBuffer({
          buffer: req.files.pan[0].buffer,
          folder: "awdiz/admissions/pan",
          publicId: `pan-${Date.now()}`,
          resource_type: "raw",
        });
        panUrl = up?.secure_url;
      }
    } catch (e) {
      console.log("pan upload skipped:", e?.message);
    }

    try {
      if (req.files?.aadhaar?.[0]) {
        const up = await uploadBuffer({
          buffer: req.files.aadhaar[0].buffer,
          folder: "awdiz/admissions/aadhaar",
          publicId: `aadhaar-${Date.now()}`,
          resource_type: "raw",
        });
        aadhaarUrl = up?.secure_url;
      }
    } catch (e) {
      console.log("aadhaar upload skipped:", e?.message);
    }

    // Data URLs for PDF (photo/pan/aadhaar)
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
          signUrl: body.signatures?.student?.signUrl || studentSignDataUrl || null,
        },
        parent: {
          ...(body.signatures?.parent || {}),
          signDataUrl:
            body.signatures?.parent?.signDataUrl || parentSignDataUrl || null,
          signUrl: body.signatures?.parent?.signUrl || parentSignDataUrl || null,
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
        counselorKey, // ✅ NEW (stored in DB)
      },
    };

    /* ==================== 2-OTP GENERATION ==================== */
    // (ENV OTP_ALWAYS ho to dono me wahi use hoga)
    const mobileOtpRaw = process.env.OTP_ALWAYS || generateOtp(6);
    const emailOtpRaw = process.env.OTP_ALWAYS || generateOtp(6);

    const mobileOtpHash = hashOtp(mobileOtpRaw);
    const emailOtpHash = hashOtp(emailOtpRaw);

    const pendingId = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;

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
      const studentPdf = await generateAdmissionPDF({ ...p, status: "pending" });
      const counselorPdf = await generateAdmissionPDF({ ...p, status: "pending" });

      const pendingStudentUrl = asUrl(studentPdf);
      const pendingCounselorUrl = asUrl(counselorPdf);

      if (!pendingStudentUrl || !pendingCounselorUrl) {
        throw new Error("PDF service did not return URL for pending PDFs.");
      }

      // Save PENDING in DB
      const saved = await Admission.create({
        ...p,
        pdf: { pendingStudentUrl, pendingCounselorUrl },
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
          pdfUrl: pendingStudentUrl,
          admissionId: String(saved._id),
          status: "Pending",
          counselorKey: p?.meta?.counselorKey, // ✅ NEW
        });
      } catch (err) {
        console.error("❌ Google Sheet (pending append) failed:", err?.message);
      }

      // Mail student (attachment + link)
      await sendAdmissionEmails({
        studentEmail: p.personal.email,
        pdfBuffer: studentPdf.buffer,
        pdfFileName: `Awdiz-Admission-${saved._id}.pdf`,
        pdfUrl: pendingStudentUrl,
        payload: p,
      });

      // Mail counselor (attachment + review link button)
      await sendCounselorMail({
        payload: { ...p, _id: saved._id },
        counselorPdfUrl: pendingCounselorUrl,
        pdfBuffer: counselorPdf.buffer,
        pdfFileName: `Awdiz-Admission-Pending-${saved._id}.pdf`,
      });

      pending.delete(pendingId);
      return res.status(200).json({
        message: "Admission Submitted – Pending Approval",
        id: saved._id,
        pdfUrl: pendingStudentUrl,
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

    // required inputs from counselor
    const feeAmountRaw = req.body?.feeAmount;
    const feeModeRaw = req.body?.feeMode;

    const feeAmount = Number(feeAmountRaw);
    const feeMode = String(feeModeRaw || "").trim().toLowerCase();

    if (!Number.isFinite(feeAmount) || feeAmount < 0) {
      return res
        .status(400)
        .send("Invalid fee amount. Please enter a valid number.");
    }
    if (!["cash", "online"].includes(feeMode)) {
      return res
        .status(400)
        .send("Invalid payment mode. Please choose Cash or Online.");
    }

    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).send("Admission not found");

    // store on admission document (keep schema-safe by using meta)
    doc.meta = doc.meta || {};
    doc.meta.feeAmount = feeAmount;
    doc.meta.feeMode = feeMode;
    doc.meta.submittedToAdminAt = new Date().toISOString();

    // Keep status pending — admin will approve later
    doc.status = doc.status || "Pending";

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
      const pdfRes = await generateAdmissionPDF(doc);
      pdfBuffer = pdfRes?.buffer || null;
      pdfUrl = asUrl(pdfRes) || doc?.pdfUrl || "";
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

    const approveUrl = `${BASE_URL}/api/admissions/${doc._id}/approve`;

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2 style="margin:0 0 8px">Admission Pending — Admin Approval Required</h2>
        <p style="margin:0 0 8px"><b>Student:</b> ${doc?.personal?.name || "-"}</p>
        <p style="margin:0 0 8px"><b>Course:</b> ${doc?.course?.name || "-"}</p>
        <p style="margin:0 0 8px"><b>Center:</b> ${doc?.center?.placeOfAdmission || "-"}</p>

        <p style="margin:0 0 8px"><b>Fees:</b> ₹${feeAmount} &nbsp; <b>Mode:</b> ${feeMode}</p>

        <p style="margin:12px 0 0">
          <a href="${approveUrl}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:10px 14px;border-radius:10px;font-weight:700">
            ✅ Approve Admission
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

    // simple success page for counselor
    return res.send(`
      <html>
        <head><meta charset="utf-8"/><title>Submitted</title></head>
        <body style="font-family:Arial,sans-serif;padding:24px">
          <h2>✅ Submitted to Admin</h2>
          <p>Fees: ₹${feeAmount} | Mode: ${feeMode}</p>
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
  try {
    const { id } = req.params;
    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).send("<h2>Not found</h2>");

    // ✅ ALWAYS use counselorKey stored in DB (reliable)
    const counselorKey =
      String(doc?.meta?.counselorKey || "c1").trim().toLowerCase() === "c2"
        ? "c2"
        : "c1";

    // Generate Approved PDF
    const approvedPdf = await generateAdmissionPDF({
      ...doc.toObject(),
      status: "approved",
    });
    const approvedUrl = asUrl(approvedPdf);
    if (!approvedUrl) {
      throw new Error("PDF service did not return URL for approved PDF.");
    }

    // Update DB
    doc.status = "approved";
    doc.pdf = { ...(doc.pdf || {}), approvedUrl };
    await doc.save();

    // ✅ Flip Google Sheet row (same AdmissionID = Mongo _id)
    try {
      await setAdmissionStatus(
        doc?.center?.placeOfAdmission || "",
        doc?.course?.name || "Admissions",
        String(doc._id),
        "Approved",
        { approvedPdfUrl: approvedUrl, counselorKey } // ✅ NEW (clean)
      );
    } catch (err) {
      console.error("❌ Google Sheet status flip failed:", err?.message);
    }

    // Mail student with Approved PDF attached
    await sendAdmissionEmails({
      studentEmail: doc.personal.email,
      pdfBuffer: approvedPdf.buffer,
      pdfFileName: `Awdiz-Admission-Approved-${doc._id}.pdf`,
      pdfUrl: approvedUrl,
      payload: { ...doc.toObject(), status: "approved" },
    });

    // Success Page for Counselor
    const logo =
      process.env.AWDIZ_LOGO_URL ||
      "https://res.cloudinary.com/www-awdiz-in/image/upload/v1675932002/logo/awdiz.png";
    const studentName = doc.personal?.name || "Student";
    const courseName = doc.course?.name || "Course";

    res.status(200).send(`
      <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;margin:50px auto;padding:32px;border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;text-align:center;">
        <img src="${logo}" alt="Awdiz" style="height:48px;margin-bottom:16px"/>
        <h2 style="color:#16a34a;margin:8px 0;">✅ Admission Approved Successfully</h2>
        <p style="font-size:16px;margin:12px 0 8px;">The admission for <b>${studentName}</b> (${courseName}) has been approved.</p>
        <p style="margin:0 0 16px;">A confirmation email with the approved PDF has been sent to the student.</p>
        <p><a href="${approvedUrl}" target="_blank" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">📄 Open Approved PDF</a></p>
        <p style="font-size:13px;color:#6b7280;margin-top:20px;">You can safely close this window after verifying the email delivery.</p>
      </div>
    `);
  } catch (e) {
    console.error("approveAdmission failed:", e);
    res.status(500).send("<h2>Server error</h2>");
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
      border-color:#ef4444;
      background:#fef2f2;
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
</style>
</head>
<body>
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
          ? `<iframe class="pdf-frame" src="${pdfUrl}"></iframe>`
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
              <div class="field-value${
                flaggedFields.includes("pf_fullName") ? " field-flagged" : ""
              }">${p.personal?.salutation || ""} ${p.personal?.name || "-"}</div>
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
              <div class="field-value${
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
              <div class="field-value${
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
              <div class="field-value${
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
              <div class="field-value${
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
              <div class="field-value${
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
              <div class="field-value${
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

      <!-- COURSE (same as before) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Course Details</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
            <label class="badge"><input type="checkbox" name="sections" value="course" /> ❌ Needs correction</label>
          </div>
        </div>
        <div class="grid-2">
          <div>
            <div class="field-label">Course Name</div>
            <div class="field-value">${p.course?.name || "-"}</div>
          </div>
          <div>
            <div class="field-label">Reference</div>
            <div class="field-value">${p.course?.reference || "-"}</div>
          </div>
          <div>
            <div class="field-label">Plan Type</div>
            <div class="field-value">${jobType}</div>
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

      <!-- IDS (same) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">ID Details</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
            <label class="badge"><input type="checkbox" name="sections" value="ids" /> ❌ Needs correction</label>
          </div>
        </div>
        <div class="grid-2">
          <div>
            <div class="field-label">PAN Number</div>
            <div class="field-value">${p.ids?.pan || "-"}</div>
          </div>
          <div>
            <div class="field-label">Aadhaar / Driving</div>
            <div class="field-value">${p.ids?.aadhaarOrDriving || "-"}</div>
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
              <div class="field-value${
                flaggedFields.includes("up_photo") ? " field-flagged" : ""
              }">${p.uploads?.photoUrl || "-"}</div>
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
              <div class="field-value${
                flaggedFields.includes("up_pan") ? " field-flagged" : ""
              }">${p.uploads?.panUrl || "-"}</div>
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
              <div class="field-value${
                flaggedFields.includes("up_aadhaar") ? " field-flagged" : ""
              }">${p.uploads?.aadhaarUrl || "-"}</div>
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

      <!-- CENTER (same) -->
      <div class="section-card">
        <div class="sec-header">
          <p class="sec-title">Center Details</p>
          <div class="sec-badges">
            <label class="badge"><input type="checkbox" disabled /> ✅ Correct</label>
            <label class="badge"><input type="checkbox" name="sections" value="center" /> ❌ Needs correction</label>
          </div>
        </div>
        <div class="grid-2">
          <div>
            <div class="field-label">Place of Admission</div>
            <div class="field-value">${p.center?.placeOfAdmission || "-"}</div>
          </div>
          <div>
            <div class="field-label">Mode</div>
            <div class="field-value">${p.center?.mode || "-"}</div>
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

        <div class="grid-2">
          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Student Name</div>
              <div class="field-value${
                flaggedFields.includes("sg_student") ? " field-flagged" : ""
              }">${p.signatures?.student?.fullName || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="sg_student" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="sg_student" value="fix" data-section="signatures" />
                ❌
              </label>
            </div>
          </div>

          <div class="field-row">
            <div class="field-main">
              <div class="field-label">Parent / Guardian Name</div>
              <div class="field-value${
                flaggedFields.includes("sg_parent") ? " field-flagged" : ""
              }">${p.signatures?.parent?.fullName || "-"}</div>
            </div>
            <div class="field-flags">
              <label class="mini-badge">
                <input type="radio" name="sg_parent" value="ok" checked />
                ✅
              </label>
              <label class="mini-badge">
                <input type="radio" name="sg_parent" value="fix" data-section="signatures" />
                ❌
              </label>
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

      <div class="actions-row">
  <button type="submit" class="btn-primary">
    <span>✏️ Request Edit from Student</span>
  </button>

  <div class="fee-row">
    <input
      class="fee-input"
      type="number"
      name="feeAmount"
      min="0"
      step="1"
      placeholder="Fees amount (required)"
      required
    />
    <select class="fee-select" name="feeMode" required>
      <option value="" disabled selected>Cash / Online</option>
      <option value="cash">Cash</option>
      <option value="online">Online</option>
    </select>

    <button
      type="submit"
      class="btn-success"
      formaction="/api/admissions/${doc._id}/submit-to-admin"
      formmethod="POST"
    >
      <span>📤 Submit to Admin</span>
    </button>
  </div>

  ${
    pdfUrl
      ? `<a href="${pdfUrl}" target="_blank" class="btn-ghost"><span>📄</span><span>Open PDF in new tab</span></a>`
      : ""
  }
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

      // ==== 2) Auto-notes generation in "notes" textarea ====
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
  </script>
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
    const base = (process.env.APP_BASE_URL || "http://localhost:3002").replace(
      /\/+$/,
      ""
    );

    const sectionsParam = encodeURIComponent(JSON.stringify(sectionsArray));
    const fieldsParam = encodeURIComponent(JSON.stringify(fieldFixKeys));

    const editLink = `${base}/admission-form?edit=1&id=${doc._id}&sections=${sectionsParam}&fields=${fieldsParam}`;

    console.log("✏️ Edit Link:", editLink);

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

    const mail = {
      from: {
        name: "Awdiz Admissions",
        address: process.env.FROM_EMAIL,
      },
      to: doc.personal?.email,
      subject: "Awdiz Admission – Edit Required",
      html: mailHtml,
    };

    await transporter.sendMail(mail);
    console.log("📨 Edit request mail sent →", doc.personal?.email);

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

/* ==================== GET DATA FOR EDIT ==================== */
async function getAdmissionForEdit(req, res) {
  try {
    const { id } = req.params;
    const { fields } = req.query; // URL se bhi fields aa sakte hai

    const doc = await Admission.findById(id);
    if (!doc) return res.status(404).json({ message: "Admission not found" });

    // 🔴 Sirf tabhi allow karo jab editPending me entry ho
    const state = editPending.get(String(id));
    const allowedSections = Array.isArray(state?.sections) ? state.sections : [];

    if (!allowedSections.length) {
      return res.status(400).json({
        message:
          "This edit link has expired or is not active. Please contact the counselor for a new edit request.",
      });
    }

    // 👉 field-level list
    let allowedFields = Array.isArray(state?.fields) ? state.fields : [];

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
    const allowedSections = Array.isArray(state?.sections) ? state.sections : [];

    if (!allowedSections.length) {
      return res.status(400).json({
        success: false,
        message:
          "Edit window has expired. Please contact counselor for a new edit request.",
      });
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
      doc.signatures = {
        ...(doc.signatures || {}),
        ...(updated.signatures || {}),
      };
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
    try {
      const base = (
        process.env.PUBLIC_BASE_URL ||
        process.env.APP_BASE_URL ||
        "http://localhost:5002"
      ).replace(/\/+$/, "");

      const reviewUrl = `${base}/api/admissions/${doc._id}/review`;

      const counselorList = (process.env.COUNSELOR_EMAILS || "")
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);

      const to = counselorList.length ? counselorList : [process.env.FROM_EMAIL];

      const studentName = doc.personal?.name || "Student";
      const courseName = doc.course?.name || "Course";

      const html = `
        <div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
          <h2 style="margin:0 0 8px;color:#16a34a;">Awdiz – Edited Admission Submitted</h2>
          <p>
            Student <b>${studentName}</b> has updated the admission form
            for course <b>${courseName}</b>.
          </p>
          <p style="margin:8px 0;">
            Please review the updated details and approve or request further changes if needed.
          </p>
          <p style="margin:14px 0;">
            <a href="${reviewUrl}"
               style="background:#2563eb;color:#ffffff;padding:10px 16px;border-radius:6px;
                      text-decoration:none;font-weight:600;"
               target="_blank">
              🔍 Open Updated Admission
            </a>
          </p>
          <p style="margin-top:12px;font-size:12px;color:#6b7280;">
            This mail was sent automatically after the student clicked "Save changes" on the edit link.
          </p>
        </div>
      `.trim();

      const mail = {
        from: {
          name: "Awdiz Admissions",
          address: process.env.FROM_EMAIL,
        },
        to,
        subject: `Edited Admission – ${studentName} (${courseName})`,
        html,
      };

      await transporter.sendMail(mail);
      console.log("📧 Counselor EDIT notification mail sent →", to);
    } catch (mailErr) {
      console.error("send counselor EDIT mail failed:", mailErr);
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
  requestEditAdmission,
  submitToAdmin,
  approveAdmission,
  getAdmissionForEdit,
  applyAdmissionEdit,
};
