// try 
// server/src/services/email.service.js
import nodemailer from "nodemailer";

/* ========================= SMTP CONFIG ========================= */
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE =
  String(process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
  SMTP_PORT === 465;

const SMTP_USER = process.env.SMTP_USER || process.env.MAIL_USER;
const SMTP_PASS = process.env.SMTP_PASS || process.env.MAIL_PASS;

if (!SMTP_USER || !SMTP_PASS) {
  console.warn("⚠️ Missing SMTP_USER / SMTP_PASS — emails may fail!");
}

const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;
const FROM_NAME = process.env.FROM_NAME || "Awdiz Admissions";
const ADMISSIONS_EMAIL = process.env.ADMISSIONS_EMAIL || ""; // office bcc (optional)

// Legacy env (fallbacks)
const COUNSELOR_EMAIL = process.env.COUNSELOR_EMAIL || ""; // counselor(s), comma-separated

// Backends / frontends (trim trailing slashes)
const BASE_URL = (process.env.PUBLIC_BASE_URL || "http://localhost:5002").replace(
  /\/+$/,
  ""
);
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");

const VERBOSE_SMTP = String(process.env.SMTP_VERBOSE || "")
  .toLowerCase()
  .trim() === "true";

/* ========================= TRANSPORTER ========================= */
export const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
  logger: VERBOSE_SMTP,
  debug: VERBOSE_SMTP,
  tls: { rejectUnauthorized: false },
});

transporter.verify().then(
  () => console.log("✅ SMTP ready"),
  (err) => console.error("❌ SMTP verify failed:", err?.message)
);

// Small util
const keep = (v, d = "-") => (v === 0 ? "0" : v ? String(v) : d);

/* Helper: build counselor review URL */
function buildReviewUrl(givenUrl, payload) {
  if (givenUrl) return givenUrl;
  const id = payload?._id || payload?.id || "unknown";
  return APP_BASE_URL
    ? `${APP_BASE_URL}/admissions/${id}/review`
    : `${BASE_URL}/api/admissions/${id}/review`;
}

/* Helper: build admin approve URL (API endpoint) */
function buildAdminApproveUrl(givenUrl, payload) {
  if (givenUrl) return givenUrl;
  const id = payload?._id || payload?.id || "unknown";
  // Keep this API-first so email button can directly hit backend route
  return `${BASE_URL}/api/admissions/${id}/approve`;
}

/* Helper: build admin view/review URL (optional) */
function buildAdminViewUrl(givenUrl, payload) {
  if (givenUrl) return givenUrl;
  const id = payload?._id || payload?.id || "unknown";
  // Admin can still open review page if you want
  return APP_BASE_URL
    ? `${APP_BASE_URL}/admissions/${id}/review`
    : `${BASE_URL}/api/admissions/${id}/review`;
}

/* ========================= HELPERS ========================= */

// normalize comma-separated string / array to clean array
function normalizeEmails(x) {
  if (!x) return [];
  if (Array.isArray(x))
    return x.map((s) => String(s).trim()).filter(Boolean);

  return String(x)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ✅ counselorKey → emails mapping (env based)
// Recommended envs:
// COUNSELOR1_EMAILS="a@x.com,b@x.com"
// COUNSELOR2_EMAILS="c@x.com,d@x.com"
// ADMIN_EMAILS="admin1@x.com,admin2@x.com"
function getCounselorEmailsByKey(key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return [];

  // ✅ support BOTH naming styles (with & without underscore)
  const C1 =
    process.env.COUNSELOR1_EMAILS ||
    process.env.COUNSELOR_1_EMAILS ||
    "";
  const C2 =
    process.env.COUNSELOR2_EMAILS ||
    process.env.COUNSELOR_2_EMAILS ||
    "";

  if (k === "counselor1" || k === "c1" || k === "sheet1" || k === "1") {
    return normalizeEmails(C1);
  }
  if (k === "counselor2" || k === "c2" || k === "sheet2" || k === "2") {
    return normalizeEmails(C2);
  }

  const rawMap = process.env.COUNSELOR_KEY_MAP || "";
  if (rawMap) {
    try {
      const obj = JSON.parse(rawMap);
      const v = obj?.[k];
      return normalizeEmails(v);
    } catch {
      console.warn("⚠️ COUNSELOR_KEY_MAP invalid JSON");
    }
  }

  return [];
}

function getAdminEmails() {
  // prefer ADMIN_EMAILS (new), else fallback ADMIN_COUNSELOR_EMAILS (your previous), else none
  return normalizeEmails(
    process.env.ADMIN_EMAILS || process.env.ADMIN_COUNSELOR_EMAILS || ""
  );
}

// normalize payment mode into "Cash" / "Online" / "-"
function normalizePaymentMode(mode) {
  const m = String(mode || "").trim().toLowerCase();
  if (!m) return "";
  if (m === "cash") return "Cash";
  if (m === "online" || m === "upi" || m === "card" || m === "netbanking")
    return "Online";
  return String(mode);
}

/* ============================================================
 * 1) STUDENT EMAIL (pending/approved)
 * ============================================================ */
export async function sendAdmissionEmails({
  studentEmail,
  pdfBuffer,
  pdfFileName = "Awdiz-Admission.pdf",
  pdfUrl,
  payload,
}) {
  if (!studentEmail) throw new Error("studentEmail is required");

  const status = String(payload?.status || "").toLowerCase(); // "pending" | "approved"
  const isApproved = status === "approved";

  const studentName = keep(payload?.personal?.name, "Student");
  const courseName = keep(payload?.course?.name);
  const mobile = keep(payload?.personal?.studentMobile);

  const subject = isApproved
    ? `AWDIZ Admission Approved – ${studentName}`
    : `AWDIZ Admission Submitted (Pending) – ${studentName}`;

  const leadLine = isApproved
    ? `Your admission has been <b>Approved</b>.`
    : `Your admission form is <b>Pending Approval</b>.`;

  const linkLabel = isApproved
    ? "📄 Download your Approved PDF"
    : "";

    // ✅ FEES DETAILS (for student approved mail)
const feeAmount =
  payload?.fees?.amount !== undefined &&
  payload?.fees?.amount !== null
    ? payload.fees.amount
    : null;

const paymentMode =
  payload?.fees?.paymentMode
    ? String(payload.fees.paymentMode).toUpperCase()
    : null;


  const html = `
  <div style="font-family:system-ui,Arial,sans-serif">
    <h2 style="color:${isApproved ? "#16a34a" : "#2563eb"};">
      AWDIZ – Admission ${isApproved ? "Approved" : "Submitted"}
    </h2>

    <p>Hi <b>${studentName}</b>,</p>
    <p>${leadLine}</p>

    ${
      !isApproved
        ? `
        <p style="font-size:13px;color:#6b7280">
          Your admission is under review. Approved admission PDF will be shared once confirmed.
        </p>
        `
        : ""
    }

    ${
      pdfUrl
        ? `<p><a href="${pdfUrl}" target="_blank" style="color:#1d4ed8;">${linkLabel}</a></p>`
        : ""
    }

    <hr/>

    <p><b>Course:</b> ${courseName}</p>
    <p><b>Mobile:</b> ${mobile}</p>
    <p><b>Email:</b> ${studentEmail}</p>

    ${
      isApproved && feeAmount !== null
        ? `
        <p><b>Registration Fees:</b> ₹${feeAmount}</p>
        <p><b>Payment Mode:</b> ${paymentMode}</p>
        `
        : ""
    }
  </div>
`.trim();


  const attachments = [];

// ✅ Student ko PDF SIRF approved hone ke baad mile
if (isApproved) {
  if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
    attachments.push({
      filename: pdfFileName,
      content: pdfBuffer,
      contentType: "application/pdf",
    });
  } else if (pdfUrl) {
    attachments.push({
      filename: pdfFileName,
      path: pdfUrl,
      contentType: "application/pdf",
    });
  }
}


  const mail = {
    from: { name: FROM_NAME, address: FROM_EMAIL },
    to: studentEmail,
    bcc: ADMISSIONS_EMAIL || undefined,
    subject,
    html,
    attachments,
    replyTo: ADMISSIONS_EMAIL || FROM_EMAIL,
  };

  const info = await transporter.sendMail(mail);
  console.log("📨 Student mail sent:", info.messageId, "→", studentEmail);
  return info;
}

/* ============================================================
 * 2) COUNSELOR EMAIL (PDF + REVIEW BUTTON + PLAIN REVIEW URL)
 *    — Counselor reviews only —
 *
 * ✅ IMPORTANT NEW FLOW:
 * - By default, counselor mail WILL NOT BCC admin.
 * - Counselor will "Submit to Admin" from the review page (frontend/backend),
 *   and then backend should call sendAdminApprovalMail().
 *
 * Backward compatible:
 * - If you still pass `bcc` explicitly, it will use that.
 * - If you set `includeAdminBcc: true`, it will include ADMIN_EMAILS.
 * ============================================================ */
export async function sendCounselorMail({
  payload, // must include _id
  counselorPdfUrl, // PDF link (review copy)
  pdfBuffer, // attach buffer if available
  pdfFileName = "Awdiz-Admission-Pending.pdf",
  reviewUrl, // optional; else built from envs

  // optional overrides
  to, // array or comma string
  bcc, // array or comma string

  // ✅ NEW: default false (to stop admin getting pending directly)
  includeAdminBcc = false,
}) {
  // 1) explicit to override
  const explicitTo = normalizeEmails(to);

  // 2) counselorKey routing
 const counselorKey =
  payload?.counselorKey ||
  payload?.meta?.counselorKey ||
  payload?.personal?.counselorKey ||
  payload?.assignedCounselorKey ||
  payload?.originalCounselorKey ||
  "";

  const routedTo = getCounselorEmailsByKey(counselorKey);

  // 3) legacy env fallback
  const legacyTo = normalizeEmails(COUNSELOR_EMAIL || "");

  // 4) office fallback
  const officeTo = normalizeEmails(ADMISSIONS_EMAIL || "");

  const finalTo = explicitTo.length
    ? explicitTo
    : routedTo.length
    ? routedTo
    : legacyTo.length
    ? legacyTo
    : officeTo;

  if (!finalTo.length) {
    console.warn(
      "⚠️ No counselor/office email configured (to / counselorKey / COUNSELOR_EMAIL / ADMISSIONS_EMAIL)."
    );
    return;
  }

  // BCC:
  // - explicit bcc always respected
  // - otherwise: includeAdminBcc ? ADMIN_EMAILS : none
  const explicitBcc = normalizeEmails(bcc);
  const adminBcc = getAdminEmails();
  const finalBcc = explicitBcc.length
    ? explicitBcc
    : includeAdminBcc
    ? adminBcc
    : [];

  const finalReviewUrl = buildReviewUrl(reviewUrl, payload);
  console.log("🧾 Counselor review URL:", finalReviewUrl);
  console.log("🧩 counselorKey:", counselorKey, "→ routed:", routedTo);

  const studentName = payload?.personal?.name || "-";
  const courseName = payload?.course?.name || "-";
  const stdEmail = payload?.personal?.email || "-";
  const stdMobile = payload?.personal?.studentMobile || "-";

  const reviewButton = `
  <table border="0" cellspacing="0" cellpadding="0" role="presentation" style="margin:10px 0 10px">
    <tr>
      <td align="center" bgcolor="#2563eb" style="border-radius:6px;background:#2563eb;">
        <a href="${finalReviewUrl}" target="_blank"
           style="display:inline-block;padding:12px 16px;font-family:Arial,Helvetica,sans-serif;
                  font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;line-height:20px;">
          🧾 Open Counselor Review
        </a>
      </td>
    </tr>
  </table>`.trim();

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111827">
    <h2 style="margin:0 0 8px">New Admission Pending Review</h2>
    <p style="margin:0 0 8px">
      <b>Student:</b> ${studentName}<br/>
      <b>Course:</b> ${courseName}<br/>
      <b>Email:</b> ${stdEmail}<br/>
      <b>Mobile:</b> ${stdMobile}<br/>
      ${counselorKey ? `<b>Counselor Key:</b> ${keep(counselorKey)}<br/>` : ""}
    </p>

    ${
      counselorPdfUrl
        ? `<p style="margin:8px 0 6px">
            <a href="${counselorPdfUrl}" target="_blank" style="color:#1d4ed8;text-decoration:underline">
              📄 Open PDF (review)
            </a>
          </p>`
        : ""
    }

    ${reviewButton}

    <p style="font-size:12px;color:#6b7280;margin:6px 0 4px">If the button doesn’t appear, use this URL:</p>
    <p style="font-size:12px;word-break:break-all;margin:0 0 12px">
      <a href="${finalReviewUrl}" target="_blank" style="color:#1d4ed8">${finalReviewUrl}</a>
    </p>

    <p style="font-size:12px;color:#6b7280;margin:0">
      Note: Counselor will submit this admission to Admin from the review page.
    </p>
    <p style="font-size:12px;color:#6b7280;margin:0">Attached: Pending PDF</p>
  </div>
  `.trim();

  const attachments = [];
  if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
    attachments.push({
      filename: pdfFileName,
      content: pdfBuffer,
      contentType: "application/pdf",
    });
  } else if (
  counselorPdfUrl &&
  !counselorPdfUrl.includes("dummy.cloudinary.com")
) {
  attachments.push({
    filename: pdfFileName,
    path: counselorPdfUrl,
    contentType: "application/pdf",
  });
}


  const mail = {
    from: { name: FROM_NAME, address: FROM_EMAIL },
    to: finalTo,
    bcc: finalBcc.length ? finalBcc : undefined,
    subject: `New Admission Pending – ${studentName}`,
    headers: {
      "X-Template": "counselor-review-v3",
      "X-Review-URL": finalReviewUrl,
      "X-Counselor-Key": counselorKey ? String(counselorKey) : "",
    },
    html,
    attachments,
    replyTo: ADMISSIONS_EMAIL || FROM_EMAIL,
  };

  console.log("📧 Counselor mail v3:", {
    to: finalTo,
    bcc: finalBcc,
    counselorKey,
    reviewUrl: finalReviewUrl,
  });

  const info = await transporter.sendMail(mail);
  console.log("📧 Counselor mail sent:", info.messageId, "→", finalTo.join(","));
  return info;
}

/* ============================================================
 * 2B) ADMIN EMAIL (PENDING -> Admin Approves)
 *
 * ✅ NEW FLOW:
 * - Counselor review page will collect:
 *   - feesAmount (required)
 *   - paymentMode (required: cash/online)
 * - When counselor clicks "Submit to Admin":
 *   backend should call sendAdminApprovalMail(...)
 *
 * Admin email must have:
 * - PDF attachment + link
 * - ONLY Approve button
 * - Approve button side shows amount + mode
 * ============================================================ */
export async function sendAdminApprovalMail({
  payload, // must include _id
  pendingPdfUrl, // cloudinary/pdf url for pending (optional)
  pdfBuffer, // attach buffer if available (optional)
  pdfFileName = "Awdiz-Admission-Pending.pdf",

  // required inputs from counselor submit
  feesAmount, // required
  paymentMode, // required ("cash" | "online")

  // optional overrides
  to, // admin emails override
  bcc, // optional bcc
  approveUrl, // optional direct approve link
  viewUrl, // optional view/review link
}) {
  const adminTo = normalizeEmails(to);
  const envAdmins = getAdminEmails();
  const finalTo = adminTo.length ? adminTo : envAdmins;

  if (!finalTo.length) {
    console.warn("⚠️ No admin email configured (ADMIN_EMAILS missing).");
    return;
  }

  // Normalize fee + mode
  const feeText = keep(feesAmount, "");
  const modeText = normalizePaymentMode(paymentMode);

  // REQUIRED validation (soft, but prevents silent bad mails)
  if (!feeText || feeText === "-" || feeText === "0") {
    console.warn("⚠️ sendAdminApprovalMail: feesAmount missing/invalid:", feesAmount);
  }
  if (!modeText) {
    console.warn("⚠️ sendAdminApprovalMail: paymentMode missing/invalid:", paymentMode);
  }

  const explicitBcc = normalizeEmails(bcc);

  const approveLink = buildAdminApproveUrl(approveUrl, payload);
  const adminViewLink = buildAdminViewUrl(viewUrl, payload);

  const studentName = payload?.personal?.name || "-";
  const courseName = payload?.course?.name || "-";
  const stdEmail = payload?.personal?.email || "-";
  const stdMobile = payload?.personal?.studentMobile || "-";
  const counselorKey =
    payload?.counselorKey ||
    payload?.meta?.counselorKey ||
    payload?.personal?.counselorKey ||
    "";

  const approveButton = `
  <table border="0" cellspacing="0" cellpadding="0" role="presentation" style="margin:12px 0 10px">
    <tr>
      <td align="center" bgcolor="#16a34a" style="border-radius:6px;background:#16a34a;">
        <a href="${approveLink}" target="_blank"
           style="display:inline-block;padding:12px 16px;font-family:Arial,Helvetica,sans-serif;
                  font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;line-height:20px;">
          ✅ Approve
        </a>
      </td>
      <td style="padding-left:12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;vertical-align:middle;">
        <div><b>Fees:</b> ${keep(feeText)}</div>
        <div><b>Mode:</b> ${keep(modeText)}</div>
      </td>
    </tr>
  </table>`.trim();

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111827">
    <h2 style="margin:0 0 8px">Admission Pending Admin Approval</h2>

    <p style="margin:0 0 8px">
      <b>Student:</b> ${studentName}<br/>
      <b>Course:</b> ${courseName}<br/>
      <b>Email:</b> ${stdEmail}<br/>
      <b>Mobile:</b> ${stdMobile}<br/>
      ${counselorKey ? `<b>Counselor Key:</b> ${keep(counselorKey)}<br/>` : ""}
      <b>Fees Amount:</b> ${keep(feeText)}<br/>
      <b>Payment Mode:</b> ${keep(modeText)}
    </p>

    ${
      pendingPdfUrl
        ? `<p style="margin:8px 0 6px">
            <a href="${pendingPdfUrl}" target="_blank" style="color:#1d4ed8;text-decoration:underline">
              📄 Open Pending PDF
            </a>
          </p>`
        : ""
    }

    ${approveButton}

    <p style="margin:6px 0 0;font-size:12px;color:#6b7280">
      (Optional) View page:
      <a href="${adminViewLink}" target="_blank" style="color:#1d4ed8">${adminViewLink}</a>
    </p>

    <p style="font-size:12px;color:#6b7280;margin:10px 0 4px">If the approve button doesn’t appear, use this URL:</p>
    <p style="font-size:12px;word-break:break-all;margin:0 0 12px">
      <a href="${approveLink}" target="_blank" style="color:#1d4ed8">${approveLink}</a>
    </p>

    <p style="font-size:12px;color:#6b7280;margin:0">Attached: Pending PDF</p>
  </div>
  `.trim();

  // const attachments = [];
  // if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
  //   attachments.push({
  //     filename: pdfFileName,
  //     content: pdfBuffer,
  //     contentType: "application/pdf",
  //   });
  // } else if (pendingPdfUrl) {
  //   attachments.push({
  //     filename: pdfFileName,
  //     path: pendingPdfUrl,
  //     contentType: "application/pdf",
  //   });
  // }

  const attachments = [];

// 1️⃣ Prefer buffer (most reliable)
if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
  attachments.push({
    filename: pdfFileName,
    content: pdfBuffer,
    contentType: "application/pdf",
  });
}

// 2️⃣ Else try URL (ONLY if real Cloudinary)
else if (
  pendingPdfUrl &&
  !pendingPdfUrl.includes("dummy.cloudinary.com")
) {
  attachments.push({
    filename: pdfFileName,
    path: pendingPdfUrl,
    contentType: "application/pdf",
  });
}


// 3️⃣ Else → NO attachment, mail still goes


  const mail = {
    from: { name: FROM_NAME, address: FROM_EMAIL },
    to: finalTo,
    bcc: explicitBcc.length ? explicitBcc : undefined,
    subject: `Admin Approval Required – ${studentName}`,
    headers: {
      "X-Template": "admin-approve-v1",
      "X-Approve-URL": approveLink,
      "X-View-URL": adminViewLink,
      "X-Counselor-Key": counselorKey ? String(counselorKey) : "",
      "X-Fees-Amount": feeText ? String(feeText) : "",
      "X-Payment-Mode": modeText ? String(modeText) : "",
    },
    html,
    attachments,
    replyTo: ADMISSIONS_EMAIL || FROM_EMAIL,
  };

  console.log("📧 Admin mail:", {
    to: finalTo,
    fee: feeText,
    mode: modeText,
    approveUrl: approveLink,
  });

  const info = await transporter.sendMail(mail);
  console.log("📧 Admin mail sent:", info.messageId, "→", finalTo.join(","));
  return info;
}

/* ============================================================
 * 3) EMAIL OTP
 * ============================================================ */
export async function sendOtpEmail({ to, name, otp }) {
  const displayName = name || "Student";

  await transporter.sendMail({
    from: { name: FROM_NAME, address: FROM_EMAIL },
    to,
    subject: "Awdiz Admission – Email OTP Verification",
    html: `
      <div style="font-family:system-ui,Arial,sans-serif;line-height:1.5">
        <p>Dear ${displayName},</p>
        <p>Your email OTP for Awdiz admission is: <b style="font-size:18px">${otp}</b></p>
        <p>This OTP is valid for 15 minutes. Please do not share it with anyone.</p>
      </div>
    `,
  });
}
