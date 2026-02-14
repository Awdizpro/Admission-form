
// src/pages/OtpVerify.jsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { getAdmissionDraft, clearAdmissionDraft } from "../lib/formStore";
import { TERMS_TEXT } from "../components/termsText";

// ✅ iOS Fix: Compress signature data URLs to reduce size
async function compressSignature(dataUrl, isIOS = false) {
  if (!dataUrl || !dataUrl.startsWith("data:image")) {
    return dataUrl;
  }

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // 🔥 iOS needs smaller dimensions to prevent memory issues
    const maxWidth = isIOS ? 400 : 600;
    let width = img.width;
    let height = img.height;

    if (width > maxWidth) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }

    canvas.width = width;
    canvas.height = height;

    // Draw with white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    // 🔥 iOS needs lower quality (0.5) to reduce data URL size
    const quality = isIOS ? 0.5 : 0.7;
    const compressed = canvas.toDataURL("image/jpeg", quality);
    console.log("Signature compressed:", {
      original: dataUrl.length,
      compressed: compressed.length,
      reduction: Math.round((1 - compressed.length / dataUrl.length) * 100) + "%",
      isIOS,
    });

    return compressed;
  } catch (err) {
    console.warn("Signature compression failed, using original:", err);
    return dataUrl;
  }
}


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
  const [emailVerifying, setEmailVerifying] = useState(false);
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

    // ✅ Detect iOS
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

    // ✅ iOS Fix: Validate parent signature exists
    if (!files?.parentSign || !files?.parentSign?.startsWith?.("data:image")) {
      return setErr("Parent signature is missing. Please go back and sign.");
    }

    // ✅ iOS Fix: Stricter signature size limits for iOS (memory issues)
    const maxSigSize = isIOS ? 200000 : 500000; // 200KB for iOS, 500KB for others
    if (files?.parentSign?.length > maxSigSize) {
      return setErr(
        isIOS 
          ? "Signature too large for iOS. Please sign smaller (iOS has strict memory limits)."
          : "Parent signature is too large. Please sign again with a smaller signature."
      );
    }

    // ✅ iOS Fix: Check total estimated FormData size
    let totalEstimatedSize = 0;
    if (files?.photo) totalEstimatedSize += files.photo.size || 0;
    if (files?.panFile) totalEstimatedSize += files.panFile.size || 0;
    if (files?.aadhaarFile) totalEstimatedSize += files.aadhaarFile.size || 0;
    if (files?.studentSign) totalEstimatedSize += files.studentSign.length || 0;
    if (files?.parentSign) totalEstimatedSize += files.parentSign.length || 0;

    // 🔥 iOS struggles with uploads > 10MB total
    const maxTotalSize = isIOS ? 8 * 1024 * 1024 : 25 * 1024 * 1024; // 8MB for iOS, 25MB for others
    if (totalEstimatedSize > maxTotalSize) {
      return setErr(
        `Total upload size (${Math.round(totalEstimatedSize / 1024 / 1024)}MB) too large for ${isIOS ? 'iOS' : 'mobile'}. ` +
        `Please use smaller files or reduce image quality. Recommended: Photo < 2MB, Documents < 3MB each.`
      );
    }

    // ✅ iOS Fix: Compress signatures before sending (reduces FormData size for iOS)
    let studentSignToSend = files?.studentSign;
    let parentSignToSend = files?.parentSign;

    try {
      // Compress if signature is a data URL (pass isIOS flag for aggressive compression)
      if (studentSignToSend?.startsWith?.("data:image")) {
        studentSignToSend = await compressSignature(studentSignToSend, isIOS);
      }
      if (parentSignToSend?.startsWith?.("data:image")) {
        parentSignToSend = await compressSignature(parentSignToSend, isIOS);
      }
    } catch (compressErr) {
      console.warn("Signature compression failed, using original:", compressErr);
      // Use original if compression fails
    }

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
    if (studentSignToSend?.startsWith?.("data:image"))
      fd.append("studentSignDataUrl", studentSignToSend);
    if (parentSignToSend?.startsWith?.("data:image"))
      fd.append("parentSignDataUrl", parentSignToSend);

    console.log("🚀 Sending OTP request...", {
      hasPhoto: !!files?.photo,
      hasPan: !!files?.panFile,
      hasAadhaar: !!files?.aadhaarFile,
      parentSignLength: parentSignToSend?.length || 0,
      studentSignLength: studentSignToSend?.length || 0,
      counselorKey,
      userAgent: navigator.userAgent,
    });

    try {
      setLoading(true);
      // ✅ iOS Fix: Remove manual Content-Type header to let Axios handle it properly
      const { data } = await api.post("/admissions/init", fd);
      console.log("OTP sent successfully, server response:", data);

      setPendingId(data.pendingId);
      setPhase("enter-otp");
    } catch (e) {
      console.error("Send OTP failed:", {
        message: e.message,
        response: e.response?.data,
        status: e.response?.status,
        code: e.code,
        stack: e.stack,
      });

      // ✅ iOS-specific error handling
      const isIOSError = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      const errorMessage = e?.response?.data?.message;
      const statusCode = e?.response?.status;
      const errorCode = e?.code;

      if (isIOSError) {
        if (errorCode === 'ECONNABORTED' || errorCode === 'ERR_NETWORK' || !errorMessage) {
          setErr(
            "iOS upload failed (likely memory/timeout). Quick fixes:\n" +
            "1) Use WiFi (not mobile data)\n" +
            "2) Sign smaller (shorter strokes)\n" +
            "3) Close all other apps\n" +
            "4) Use 'Choose file' instead of camera\n" +
            "5) Try on a device with more RAM"
          );
        } else if (statusCode === 413) {
          setErr("Files too large. Please use smaller photos/documents (< 3MB each).");
        } else {
          setErr(errorMessage || "iOS upload failed. Try WiFi or smaller files.");
        }
      } else {
        if (statusCode === 413) {
          setErr("Files too large. Maximum total size is 35MB.");
        } else {
          setErr(errorMessage || "Failed to send OTP. Please try again.");
        }
      }
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
    
    // Prevent double submission
    if (loading || emailVerifying) {
      console.log('Already processing, ignoring duplicate click');
      return;
    }
    
    setErr("");
    if (!pendingId || !emailOtp) return setErr("Enter the Email OTP");
    if (!mobileVerified) return setErr("Please verify Mobile OTP first.");

    try {
      setEmailVerifying(true);   // ✅ START FULL PAGE LOADER
      setLoading(true);          // button disable ke liye

      // Add longer timeout for backend processing (PDF + emails take time)
      const { data } = await api.post("/admissions/verify", {
        pendingId,
        otp: emailOtp,
        channel: "email",
      }, {
        timeout: 120000 // 120 seconds timeout (2 minutes) for PDF generation + emails
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
        e.response?.data || e.message,
        "Error code:", e.code,
        "Error name:", e.name
      );
      
      // Check if it's a network/timeout error but backend might have processed
      const isNetworkError = e.code === 'ERR_NETWORK' || 
                            e.code === 'ECONNABORTED' || 
                            e.message?.includes('timeout') ||
                            e.message?.includes('Network Error');
      
      // If it's a network error, check if admission was actually successful
      if (isNetworkError) {
        console.log('Network error occurred, checking if admission was successful...');
        
        // Wait a bit then check admission status
        setTimeout(async () => {
          try {
            // Try to get admission status using pendingId
            const checkRes = await api.get(`/admissions/check-status/${pendingId}`, {
              timeout: 10000
            });
            
            if (checkRes.data?.success) {
              console.log('Admission was successful! Redirecting...');
              clearAdmissionDraft();
              nav("/admission-success", {
                state: { pdfUrl: checkRes.data.pdfUrl, id: checkRes.data.id },
              });
              return;
            }
          } catch (checkErr) {
            console.log('Status check failed:', checkErr.message);
          }
          
          // If we reach here, admission failed
          setEmailVerifying(false);
          setLoading(false);
          setErr("Network error. Please check your connection and try again.");
        }, 3000); // Wait 3 seconds before checking
        
        return; // Don't show error yet, wait for status check
      }
      
      // Show error for real errors
      setEmailVerifying(false);
      setLoading(false);
      setErr(e?.response?.data?.message || "Email OTP verification failed");
    }
  };
  function FullPageSpinner() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/70">
      <div
        className="w-24 h-24 rounded-full animate-spin
          border-[8px]
          border-t-red-500
          border-r-yellow-400
          border-b-green-500
          border-l-blue-500
        "
      />
    </div>
  );
}


  return (
    <> 
     {emailVerifying && <FullPageSpinner />}
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
              onChange={(e) => {
                setOtp(e.target.value);
                if (err) setErr(""); // Clear error when user types new OTP
              }}
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
              onChange={(e) => {
                setEmailOtp(e.target.value);
                if (err) setErr(""); // Clear error when user types new OTP
              }}
              placeholder="Enter 6-digit Email OTP"
              maxLength={6}
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              disabled={!mobileVerified}
            />
            <button
              disabled={loading || emailVerifying || !mobileVerified}
              className="bg-black text-white px-5 py-2 rounded disabled:opacity-60"
            >
              {loading || emailVerifying ? "Verifying…" : "Verify Email OTP & Submit"}
            </button>
          </form>
        </>
      )}
    </div>
    </>
  );
}
