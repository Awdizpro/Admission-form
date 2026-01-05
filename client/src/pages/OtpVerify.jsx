
// src/pages/OtpVerify.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { getAdmissionDraft, clearAdmissionDraft } from "../lib/formStore";
import { TERMS_TEXT } from "../components/termsText";

export default function OtpVerify() {
  const nav = useNavigate();
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [pendingId, setPendingId] = useState("");

  // ✅ mobile OTP
  const [otp, setOtp] = useState("");
  const [mobileVerified, setMobileVerified] = useState(false);

  // ✅ email OTP
  const [emailOtp, setEmailOtp] = useState("");

  const [phase, setPhase] = useState("enter-mobile");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const { payload } = getAdmissionDraft();
    if (!payload) {
      nav("/admission-form");
      return;
    }
    // ✅ yahi wali values hi auth ke liye valid hongi
    setMobile(payload?.personal?.studentMobile || "");
    setEmail(payload?.personal?.email || "");
  }, [nav]);

  // Send OTP + upload draft (MOBILE + EMAIL)
  const sendOtp = async (e) => {
    e.preventDefault();
    setErr("");

    const { payload, files } = getAdmissionDraft();
    if (!payload) return setErr("Session expired. Please fill the form again.");
    if (!mobile) return setErr("Mobile number missing from form data.");

    const fd = new FormData();

    // ✅ counselorKey forward (backend routing ke liye)
    const counselorKey =
      payload?.meta?.counselorKey || payload?.counselorKey || "c1";

    // prepare final payload with correct T&C
    const tcTextToUse =
      payload?.tcText ||
      payload?.tc?.text ||
      (payload?.course?.trainingOnly
        ? `Fees once paid will not be refunded or adjusted under any circumstances.
By signing this document, you acknowledge that you have received and agreed to learn the syllabus shared by Awdiz.`
        : TERMS_TEXT);

    // ✅ IMPORTANT:
    // yaha par hum payload.personal ko as-is bhej rahe hain,
    // OTP page se mobile/email override NHI kar rahe.
    const enhanced = {
      ...payload,
      personal: { ...payload.personal },
      termsAccepted: true,
      tcVersion: payload.tcVersion || "2025-10-16",
      tcText: tcTextToUse,

      // ✅ keep tc in sync (and include data consent)
      tc: {
        accepted: true,
        version: payload.tcVersion || "2025-10-16",
        text: tcTextToUse,
        type: payload?.course?.trainingOnly ? "training-only" : "job-guarantee",
        dataConsentAccepted: !!(
          payload?.dataConsentAccepted || payload?.tc?.dataConsentAccepted
        ),
      },

      // ✅ meta forward (counselorKey included)
      meta: {
        ...(payload?.meta || {}),
        counselorKey,
      },

      // ✅ also keep top-level (extra safe, if backend reads from here)
      counselorKey,
    };

    fd.append("payload", JSON.stringify(enhanced));

    // ✅ ALSO send counselorKey as separate field (FormData)
    fd.append("counselorKey", counselorKey);

    // append all uploaded files
    if (files?.photo) fd.append("photo", files.photo);
    if (files?.panFile) fd.append("pan", files.panFile);
    if (files?.aadhaarFile) fd.append("aadhaar", files.aadhaarFile);
    if (files?.studentSign?.startsWith?.("data:image"))
      fd.append("studentSignDataUrl", files.studentSign);
    if (files?.parentSign?.startsWith?.("data:image"))
      fd.append("parentSignDataUrl", files.parentSign);

    try {
      setLoading(true);
      const { data } = await api.post("/admissions/init", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      console.log("OTP sent successfully, server response:", data);

      setPendingId(data.pendingId);
      setPhase("enter-otp");
    } catch (e) {
      console.error("Send OTP failed:", e.response?.data || e.message);
      setErr(
        e?.response?.data?.message ||
          "Failed to send OTP. Check console for details."
      );
    } finally {
      setLoading(false);
    }
  };

  // ✅ Step 1: Verify MOBILE OTP only
  const verifyMobileOtp = async (e) => {
    e.preventDefault();
    setErr("");
    if (!pendingId || !otp) return setErr("Enter the Mobile OTP");

    try {
      setLoading(true);

      // yaha backend ko batayenge ki ye MOBILE ka OTP hai
      await api.post("/admissions/verify", {
        pendingId,
        otp,
        channel: "mobile",
      });

      setMobileVerified(true);
    } catch (e) {
      console.error(
        "Mobile OTP verification failed:",
        e.response?.data || e.message
      );
      setErr(e?.response?.data?.message || "Mobile OTP verification failed");
    } finally {
      setLoading(false);
    }
  };

  // ✅ Step 2: Verify EMAIL OTP + success
  const verifyEmailOtp = async (e) => {
    e.preventDefault();
    setErr("");
    if (!pendingId || !emailOtp) return setErr("Enter the Email OTP");
    if (!mobileVerified) return setErr("Please verify Mobile OTP first.");

    try {
      setLoading(true);

      // 1️⃣ Verify EMAIL OTP
      const { data } = await api.post("/admissions/verify", {
        pendingId,
        otp: emailOtp,
        channel: "email",
      });

      // ✅ IMPORTANT:
      // Google Sheet call yaha se REMOVE kiya, kyunki route 404 aa raha hai.
      // Sheets append backend verifyAdmission (email step) me hi hona chahiye.

      // 2️⃣ Clear draft & navigate to success
      clearAdmissionDraft();
      nav("/admission-success", {
        state: { pdfUrl: data.pdfUrl, id: data.id },
      });
    } catch (e) {
      console.error(
        "Email OTP verification failed:",
        e.response?.data || e.message
      );
      setErr(e?.response?.data?.message || "Email OTP verification failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto p-6 space-y-4 bg-white rounded border">
      <h1 className="text-2xl font-semibold">Mobile & Email Authentication</h1>

      {err && (
        <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded">
          {err}
        </div>
      )}

      {/* PHASE 1: Mobile number confirmation + Send OTP */}
      {phase === "enter-mobile" && (
        <form onSubmit={sendOtp} className="space-y-3">
          <label className="block text-sm">Mobile Number</label>
          <input
            className="border p-2 rounded w-full"
            value={mobile}
            readOnly // ✅ OTP page se change nahi hoga
            placeholder="Mobile from admission form"
          />
          <p className="text-xs text-gray-600">
            To change mobile or email, please go back and edit the admission
            form.
          </p>
          <button
            disabled={loading}
            className="bg-black text-white px-5 py-2 rounded"
          >
            {loading ? "Sending…" : "Send OTP to Mobile & Email"}
          </button>
        </form>
      )}

      {/* PHASE 2: Same page par pehle MOBILE OTP, phir EMAIL OTP */}
      {phase === "enter-otp" && (
        <>
          {/* --- MOBILE OTP BLOCK --- */}
          <form
            onSubmit={verifyMobileOtp}
            className="space-y-3 mb-4 border-b pb-4"
          >
            <p className="text-sm text-gray-700">
              Mobile OTP sent to <b>{mobile}</b>
            </p>
            <input
              className="border p-2 rounded w-full"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="Enter 6-digit Mobile OTP"
              maxLength={6}
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              disabled={mobileVerified}
            />
            <div className="flex gap-2 items-center">
              <button
                disabled={loading || mobileVerified}
                className="bg-black text-white px-5 py-2 rounded disabled:opacity-60"
              >
                {mobileVerified ? "Mobile Verified ✓" : "Verify Mobile OTP"}
              </button>
              <button
                type="button"
                className="px-4 py-2 border rounded text-sm"
                onClick={() => nav("/admission-form")}
              >
                Change Number (Edit Form)
              </button>
            </div>
          </form>

          {/* --- EMAIL OTP BLOCK (same page, neeche) --- */}
          <form onSubmit={verifyEmailOtp} className="space-y-3">
            <p className="text-sm text-gray-700">
              Email OTP sent to <b>{email}</b>
            </p>
            <p className="text-xs text-gray-600">
              {mobileVerified
                ? "Mobile verified. Now verify your email to complete admission."
                : "Please verify Mobile OTP first. Email verification will be enabled afterwards."}
            </p>
            <input
              className="border p-2 rounded w-full"
              value={emailOtp}
              onChange={(e) => setEmailOtp(e.target.value)}
              placeholder="Enter 6-digit Email OTP"
              maxLength={6}
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              disabled={!mobileVerified}
            />
            <button
              disabled={loading || !mobileVerified}
              className="bg-black text-white px-5 py-2 rounded disabled:opacity-60"
            >
              {loading ? "Verifying…" : "Verify Email OTP & Submit"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
