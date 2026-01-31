
// client/src/pages/AdmissionForm.jsx

import { useNavigate, useSearchParams } from "react-router-dom";
import { setAdmissionDraft } from "../lib/formStore";
import { useEffect, useRef, useState } from "react";
import SignaturePad from "../components/SignaturePad.jsx";
import TermsAndConditions from "../components/TermsAndConditions.jsx";
import { TERMS_TEXT } from "../components/termsText";
import { api } from "../lib/api";



// Short T&C for Training-only users
const TRAINING_ONLY_TNC = `Fees once paid will not be refunded or adjusted under any circumstances.
By signing this document, you acknowledge that you have received and agreed to learn the syllabus shared by Awdiz.`;

// helper: a signature dataURL should start with data:image and be reasonably long
const hasSign = (s) =>
  typeof s === "string" && s.startsWith("data:image") && s.length > 500;

export default function AdmissionForm() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();

  const rawC = (searchParams.get("c") || "c1").toLowerCase();

  const allowed = new Set(["c1", "1", "counselor1", "c2", "2", "counselor2"]);
  if (!allowed.has(rawC)) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border rounded-lg p-6 text-center">
          <h2 className="text-xl font-semibold text-red-600">Invalid Link</h2>
          <p className="text-sm text-gray-700 mt-2">
            This counselor link is not valid. Please ask your counselor for the correct link.
          </p>
        </div>
      </div>
    );
  }

  const counselorKey =
    rawC === "c2" || rawC === "2" || rawC === "counselor2" ? "c2" : "c1";

  // 🔐 LocalStorage key (counselor-wise)
  const LS_KEY = `awdiz_admission_draft_${counselorKey}`;
  // 🔁 EDIT MODE STATE (based on query params)
  const [restored, setRestored] = useState(false);
  const editMode = searchParams.get("edit") === "1";
  const admissionId = searchParams.get("id") || "";
  const [allowedSections, setAllowedSections] = useState([]); // e.g. ["personal","course"]
  const [allowedFields, setAllowedFields] = useState([]); // e.g. ["pf_fullName","pf_email"]

  // ---- form state ----
  const [form, setForm] = useState({
    personal: {
      salutation: "Mr",
      name: "",
      fatherOrGuardianName: "",
      address: "",
      parentMobile: "",
      studentMobile: "",
      whatsappMobile: "",
      email: "",
    },
    course: {
      name: "",
      reference: "",
      trainingOnly: false, // <-- radio decides this (Job = false, Training-only = true)
    },
    education: [
      { qualification: "", school: "", year: "", percentage: "" },
      { qualification: "", school: "", year: "", percentage: "" },
      { qualification: "", school: "", year: "", percentage: "" },
      { qualification: "", school: "", year: "", percentage: "" },
    ],
    ids: { pan: "", aadhaarOrDriving: "" },
    center: { placeOfAdmission: "", mode: "" },
    signatures: {
      student: { fullName: "", signDataUrl: "" },
      parent: { fullName: "", signDataUrl: "" }, // optional
    },
    termsAccepted: false,
    dataConsentAccepted: false,   // ⬅️ NEW

    tcVersion: "2025-10-16",
    tcText: "",
  });

  // 💾 AUTO SAVE FORM TO LOCAL STORAGE (NEW ADMISSION ONLY)
  useEffect(() => {
    if (editMode || !restored) return;

    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          form,
          savedAt: Date.now(),
        })
      );
    } catch (e) {
      console.warn("LocalStorage save failed:", e);
    }
  }, [form, editMode, LS_KEY]);


  // 🆕 original snapshot for edit-mode comparison
  const [originalForm, setOriginalForm] = useState(null);

  // ---- files ----
  const [photo, setPhoto] = useState(null);
  const [panFile, setPanFile] = useState(null);
  const [aadhaarFile, setAadhaarFile] = useState(null);

  const [loading, setLoading] = useState(false);
  const [imageProcessing, setImageProcessing] = useState(false);
  const [error, setError] = useState("");

  // ================= CAMERA STATES =================
  const [cameraOpen, setCameraOpen] = useState(false);
  const [capturedUrl, setCapturedUrl] = useState("");
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  // fix black video after retake (Chromium quirk)
  const [videoKey, setVideoKey] = useState(0);

  // select option & hidden file input for passport photo
  // const [photoOption, setPhotoOption] = useState("");
  // const photoInputRef = useRef(null);

  // ================= DEVICE DETECTION =================
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);



  // ================= Passport photo refs =================
  const [photoOption, setPhotoOption] = useState("");
  const photoPickerRef = useRef(null); // ✅ single input for iPhone / upload
  const photoCameraRef = useRef(null); // ✅ camera-only input for Android

  async function normalizeImageFile(file) {
    // only images
    // 🔥 iPhone camera fix: force normalize unknown / HEIC images
    if (!file) return file;

    // Check if it's already a valid JPEG/PNG that doesn't need processing
    // 🔥 iOS needs smaller files - use 1MB threshold for iOS
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const maxSizeThreshold = isIOS ? 1 * 1024 * 1024 : 2 * 1024 * 1024; // 1MB for iOS, 2MB for others
    
    const isAlreadyOptimized =
      (file.type === "image/jpeg" || file.type === "image/png") &&
      file.size < maxSizeThreshold;

    if (isAlreadyOptimized) {
      return file;
    }

    const isImage =
      file.type.startsWith("image/") ||
      file.name?.toLowerCase().endsWith(".heic") ||
      file.name?.toLowerCase().endsWith(".heif");

    if (!isImage) return file;

    // iPhone HEIC / HEIF / large images fix
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      console.warn("ImageBitmap failed, returning original file", err);
      // 🔒 Fallback: return original file wrapped in new File to ensure proper type
      return new File(
        [file],
        `photo-${Date.now()}.jpg`,
        { type: "image/jpeg" }
      );
    }

    const canvas = document.createElement("canvas");

    // 🔥 iOS needs smaller dimensions to prevent memory issues during upload
    // iPhone camera photos can be 3000+ pixels, we reduce more aggressively for iOS
    const MAX = isIOS ? 1200 : 1600;
    let { width, height } = bitmap;

    if (width > MAX || height > MAX) {
      const scale = Math.min(MAX / width, MAX / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);

    // 🔥 iOS needs lower quality to keep file size small (memory issues)
    const quality = isIOS ? 0.7 : 0.85;
    const blob = await new Promise((res) =>
      canvas.toBlob(res, "image/jpeg", quality)
    );

    return new File(
      [blob],
      `photo-${Date.now()}.jpg`,
      { type: "image/jpeg" }
    );
  }

  const photoReadyRef = useRef(false);

  useEffect(() => {
    photoReadyRef.current = !!photo;
  }, [photo]);


  // 🔁 EDIT-MODE: helper – pure section ke liye (fallback)
  function isSectionEditable(section) {
    if (!editMode) return true; // normal flow → sab editable
    if (!allowedSections.length) return false;
    return allowedSections.includes(section);
  }

  // 🔁 EDIT-MODE: field-level helper – ✅ / ❌ ke hisaab se
  // function isFieldEditable(sectionKey, fieldKey) {
  //   if (!editMode) return true; // normal mode me sab editable

  //   // agar section hi allowed nahi hai, to field bhi nahi
  //   if (!allowedSections.includes(sectionKey)) return false;

  //   // agar backend ne allowedFields nahi bheja, to pura section editable rakho
  //   if (!allowedFields.length) return true;

  //   // sirf wohi field editable jiska key list me hai (❌ wale)
  //   return allowedFields.includes(fieldKey);
  // }

  function isFieldEditable(sectionKey, fieldKey) {
    if (!editMode) return true;

    // ✅ agar section ❌ hai → poora section editable
    if (allowedSections.includes(sectionKey)) {
      // agar field-level ❌ aaye hain → sirf wahi editable
      if (allowedFields.length > 0) {
        return allowedFields.includes(fieldKey);
      }

      // ❌ sirf section-level case
      return true;
    }

    // ❌ section allowed nahi
    return false;
  }


  // 🔴 NEW – ❌ fields ko red highlight dene ke liye
  // function isFieldHighlighted(sectionKey, fieldKey) {
  //   if (!editMode) return false;
  //   if (!allowedSections.includes(sectionKey)) return false;
  //   if (!allowedFields.length) return false;
  //   return allowedFields.includes(fieldKey);
  // }

  function isFieldHighlighted(sectionKey, fieldKey) {
    if (!editMode) return false;

    // ❌ section-level cross → full section red
    if (allowedSections.includes(sectionKey) && allowedFields.length === 0) {
      return true;
    }

    // ❌ field-level cross → only specific fields red
    if (
      allowedSections.includes(sectionKey) &&
      allowedFields.length > 0 &&
      allowedFields.includes(fieldKey)
    ) {
      return true;
    }

    return false;
  }


  // 🔁 RESTORE FORM FROM LOCAL STORAGE (NEW ADMISSION ONLY)
  useEffect(() => {
    if (editMode) return;

    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) {
        setRestored(true); // ⬅️ nothing to restore
        return;
      }

      const parsed = JSON.parse(raw);
      if (!parsed?.form) {
        setRestored(true);
        return;
      }

      setForm((prev) => ({
        ...prev,
        personal: { ...prev.personal, ...parsed.form.personal },
        course: { ...prev.course, ...parsed.form.course },
        education: parsed.form.education || prev.education,
        ids: { ...prev.ids, ...parsed.form.ids },
        center: { ...prev.center, ...parsed.form.center },
        signatures: {
          student: {
            ...prev.signatures.student,
            ...parsed.form.signatures?.student,
          },
          parent: {
            ...prev.signatures.parent,
            ...parsed.form.signatures?.parent,
          },
        },
        termsAccepted: parsed.form.termsAccepted || false,
        dataConsentAccepted: parsed.form.dataConsentAccepted || false,
        tcVersion: parsed.form.tcVersion || prev.tcVersion,
        tcText: parsed.form.tcText || prev.tcText,
      }));
    } catch (e) {
      console.warn("LocalStorage restore failed:", e);
    } finally {
      setRestored(true); // ✅ restore finished
    }
  }, [editMode, LS_KEY]);

  // 🔁 EDIT-MODE: existing admission load
  useEffect(() => {
    if (!editMode || !admissionId) return;

    const load = async () => {
      try {
        const rawSections = searchParams.get("sections") || "[]";
        const rawFields = searchParams.get("fields") || "[]";

        let parsedSections = [];
        let parsedFields = [];
        try {
          parsedSections = JSON.parse(rawSections);
        } catch {
          parsedSections = [];
        }
        try {
          parsedFields = JSON.parse(rawFields);
        } catch {
          parsedFields = [];
        }

        const res = await api.get(
          `/admissions/${admissionId}/edit-data` +
          `?sections=${encodeURIComponent(rawSections)}` +
          `&fields=${encodeURIComponent(rawFields)}`
        );

        setAllowedSections(res.data.allowedSections || parsedSections || []);
        setAllowedFields(res.data.allowedFields || parsedFields || []);

        const a = res.data.admission;

        // merge with defaults so undefined
        setForm((prev) => {
          const merged = {
            ...prev,
            personal: { ...prev.personal, ...(a.personal || {}) },
            course: { ...prev.course, ...(a.course || {}) },
            education:
              Array.isArray(a.education) && a.education.length
                ? a.education
                : prev.education,
            ids: { ...prev.ids, ...(a.ids || {}) },
            center: { ...prev.center, ...(a.center || {}) },
            signatures: {
              student: {
                ...prev.signatures.student,
                ...(a.signatures?.student || {}),
              },
              parent: {
                ...prev.signatures.parent,
                ...(a.signatures?.parent || {}),
              },
            },
            // termsAccepted: true,
            // tcVersion: a.tcVersion || prev.tcVersion,
            // tcText: a.tcText || prev.tcText,
            termsAccepted: a?.termsAccepted ?? a?.tc?.accepted ?? true,
            dataConsentAccepted: a?.dataConsentAccepted ?? a?.tc?.dataConsentAccepted ?? true,

            tcVersion: a.tcVersion || prev.tcVersion,
            tcText: a.tcText || prev.tcText,

          };

          // 🆕 snapshot hold karo for diff check
          setOriginalForm(merged);
          return merged;
        });
      } catch (err) {
        console.error("Edit load failed", err);

        // 400 -> expired link
        if (err?.response?.status === 400) {
          setError("expired-link");
        } else {
          setError("Unable to load admission for editing.");
        }
      }
    };

    load();
  }, [editMode, admissionId, searchParams]);

  // ---- helpers to handle video stream binding ----
  const bindStreamToVideo = async () => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    video.muted = true;
    video.setAttribute("playsinline", "true");

    const tryPlay = () => {
      video
        .play()
        .catch(() => {
          try {
            video.muted = true;
            video.play().catch(() => { });
          } catch { }
        });
    };

    if (video.readyState >= 2) {
      tryPlay();
    } else {
      video.onloadedmetadata = () => tryPlay();
    }
  };

  const resumeCamera = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    const live =
      !!track && track.readyState === "live" && track.enabled !== false;

    if (!streamRef.current || !live) {
      await openCamera();
    } else {
      await bindStreamToVideo();
    }
  };

  const openCamera = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setCapturedUrl("");
      setCameraOpen(true);
      setTimeout(bindStreamToVideo, 0);
    } catch (e) {
      setError(
        "Camera permission denied or not available. You can still upload from files."
      );
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  // ✅ YAHI PASTE KARNA HAI (EXACT)
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  useEffect(() => {
    if (!cameraOpen) return;
    bindStreamToVideo();
    return () => { };
  }, [cameraOpen]);

  const handleCapture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    setCapturedUrl(dataUrl);
  };

  const handleRetake = async () => {
    setCapturedUrl("");
    setVideoKey((k) => k + 1);
    await resumeCamera();
    setTimeout(bindStreamToVideo, 0);
  };

  // const handleUsePhoto = async () => {
  //   if (!capturedUrl) return;

  //   const blob = await (await fetch(capturedUrl)).blob();
  //   const file = new File([blob], `camera-photo-${Date.now()}.jpg`, {
  //     type: "image/jpeg",
  //   });

  //   setPhoto(file);
  //   setCapturedUrl(""); // ✅ clean
  //   setCameraOpen(false);
  //   stopCamera();
  // };

  const handleUsePhoto = async () => {
    if (!capturedUrl) return;

    const blob = await (await fetch(capturedUrl)).blob();
    const rawFile = new File([blob], `camera-photo-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });

    const normalized = await normalizeImageFile(rawFile);

    setPhoto(normalized);
    setCapturedUrl("");
    setCameraOpen(false);
    stopCamera();
  };


  const handleCloseCamera = () => {
    setCameraOpen(false);
    stopCamera();
    setCapturedUrl("");
  };

  // select change handler (Choose file / Take photo)
  const onPhotoOptionChange = (e) => {
    const v = e.target.value;
    setPhotoOption(""); // UI reset

    // ✅ iOS is handled separately with inline inputs, skip this logic
    if (isIOS) return;

    // ✅ Android + Desktop
    if (v === "upload") {
      photoPickerRef.current?.click();
      return;
    }

    if (v === "camera") {
      // Android camera via native capture input
      if (isMobile) {
        photoCameraRef.current?.click();
      } else {
        // Desktop -> custom modal camera
        openCamera();
      }
    }
  };


  // ---- education rows ----
  const addEdu = () =>
    setForm((f) => ({
      ...f,
      education: [
        ...f.education,
        { qualification: "", school: "", year: "", percentage: "" },
      ],
    }));

  const rmEdu = (i) =>
    setForm((f) => ({
      ...f,
      education: f.education.filter((_, idx) => idx !== i),
    }));

  // 🆕 helper: backend ke fieldKey se current value nikalna
  const getValueForKey = (srcForm, key) => {
    if (!srcForm || !key) return "";

    // ---------- PERSONAL (pf_) ----------
    if (key === "pf_fullName") {
      const sal = srcForm.personal?.salutation || "";
      const nm = srcForm.personal?.name || "";
      return `${sal} ${nm}`.trim();
    }
    if (key === "pf_guardian")
      return srcForm.personal?.fatherOrGuardianName || "";
    if (key === "pf_address") return srcForm.personal?.address || "";
    if (key === "pf_studentMobile") return srcForm.personal?.studentMobile || "";
    if (key === "pf_whatsapp") return srcForm.personal?.whatsappMobile || "";
    if (key === "pf_email") return srcForm.personal?.email || "";
    if (key === "pf_parentMobile") return srcForm.personal?.parentMobile || "";

    // ---------- SIGNATURES (sg_) ----------
    if (key === "sg_student") {
      const nm = srcForm.signatures?.student?.fullName || "";
      const sign = srcForm.signatures?.student?.signDataUrl || "";
      return `${nm}||${sign}`;
    }
    if (key === "sg_parent") {
      const nm = srcForm.signatures?.parent?.fullName || "";
      const sign = srcForm.signatures?.parent?.signDataUrl || "";
      return `${nm}||${sign}`;
    }

    // ---------- COURSE (cr_) ----------
    if (key === "cr_name") return srcForm.course?.name ?? "";
    if (key === "cr_reference") return srcForm.course?.reference ?? "";
    if (key === "cr_planType") {
      // job vs training-only
      return srcForm.course?.trainingOnly ? "training-only" : "job";
    }

    // ---------- CENTER (center_) ----------
    if (key === "center_place")
      return srcForm.center?.placeOfAdmission ?? "";
    if (key === "center_mode") return srcForm.center?.mode ?? "";

    // ---------- IDS (id_) ----------
    if (key === "id_pan") return srcForm.ids?.pan ?? "";
    if (key === "id_aadhaar") return srcForm.ids?.aadhaarOrDriving ?? "";

    // ---------- EDUCATION (ed_q_i / ed_s_i / ed_y_i / ed_p_i) ----------
    if (key.startsWith("ed_")) {
      // pattern: ed_q_0, ed_s_1, ed_y_2, ed_p_3
      const parts = key.split("_"); // ["ed","q","0"]
      if (parts.length === 3) {
        const type = parts[1]; // q/s/y/p
        const idx = parseInt(parts[2], 10);
        const row = srcForm.education?.[idx] || {};
        if (type === "q") return row.qualification ?? "";
        if (type === "s") return row.school ?? "";
        if (type === "y") return row.year ?? "";
        if (type === "p") return row.percentage ?? "";
      }
    }

    // uploads (up_*) ka comparison alag se submit me hoga
    return "";
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    
    // 🔒 Check if image is still processing
    if (imageProcessing) {
      setError("Please wait, photo is processing. Try again.");
      return;
    }
    
    // Photo required check
    if (!photo) {
      setError("Passport photo is required. Please select or capture a photo.");
      return;
    }


    // 🔴 SECTION-LEVEL ❌ VALIDATION
    if (editMode && admissionId && allowedSections.length && allowedFields.length === 0) {
      if (!originalForm) return;

      const sectionChanged = allowedSections.some((section) => {
        return JSON.stringify(originalForm[section]) !== JSON.stringify(form[section]);
      });

      if (!sectionChanged) {
        setError(
          "Please make at least one change in the highlighted section before submitting."
        );
        return;
      }
    }


    // 🔁 EDIT-MODE: existing admission update → no OTP / no file upload
    if (editMode && admissionId) {
      // 🆕 Counselor ne jis jis field ko ❌ mark kiya,
      // un sab me change karna COMPULSORY hai.
      if (allowedFields.length && originalForm) {
        const notChanged = allowedFields.filter((key) => {
          // ---- UPLOADS: naya file dena hi padega ----
          if (key === "up_photo") return !photo; // still null => not changed
          if (key === "up_pan") return !panFile;
          if (key === "up_aadhaar") return !aadhaarFile;

          // ---- BAAKI SAB (personal / course / center / ids / education / signatures) ----
          const beforeVal = getValueForKey(originalForm, key);
          const nowVal = getValueForKey(form, key);

          return String(beforeVal ?? "") === String(nowVal ?? "");
        });

        if (notChanged.length) {
          setError(
            "Please update all highlighted fields before submitting your corrections."
          );
          return; // ❌ API call hi nahi jayega
        }
      }

      try {
        setLoading(true);
        
        // ✅ Create FormData for file uploads in edit mode
        const fd = new FormData();
        fd.append("sections", JSON.stringify(allowedSections));
        fd.append("updated", JSON.stringify({
          ...form,
          tc: {
            ...(form.tc || {}),
            accepted: !!form.termsAccepted,
            dataConsentAccepted: !!form.dataConsentAccepted,
          },
        }));
        
        // ✅ Append files if they exist (new uploads during edit)
        if (photo) fd.append("photo", photo);
        if (panFile) fd.append("pan", panFile);
        if (aadhaarFile) fd.append("aadhaar", aadhaarFile);
        
        console.log("📝 Edit submission with files:", {
          hasPhoto: !!photo,
          hasPan: !!panFile,
          hasAadhaar: !!aadhaarFile,
          allowedSections,
        });
        
        await api.post(`/admissions/${admissionId}/apply-edit`, fd);
        setLoading(false);
        alert("Your changes have been submitted. Counselor will review.");
        return;
      } catch (err) {
        console.error("Edit submit failed:", err);
        setLoading(false);

        if (err?.response?.status === 400) {
          setError("expired-link");
        } else {
          setError("Edit submit failed. Please try again.");
        }
        return;
      }
    }

    // ================= NORMAL NEW-ADMISSION FLOW =================

    // normalize + trim
    const name = (form.personal.name || "").trim();
    const courseName = (form.course.name || "").trim();
    const studMobile = (form.personal.studentMobile || "").replace(/\D/g, "");
    const waMobile = (form.personal.whatsappMobile || "").replace(/\D/g, "");
    const parentMobile = (form.personal.parentMobile || "").replace(/\D/g, "");
    const email = (form.personal.email || "").trim();
    const place = (form.center.placeOfAdmission || "").trim();
    const mode = (form.center.mode || "").trim();
    const agreed = !!form.termsAccepted;
    const dataConsent = !!form.dataConsentAccepted;  // ⬅️ NEW

    const missing = [];
    if (!name) missing.push("Name");
    if (!courseName) missing.push("Course");
    if (!/^\d{10}$/.test(studMobile))
      missing.push("Student Mobile (10 digits)");
    if (!/^\d{10}$/.test(waMobile))
      missing.push("WhatsApp Mobile (10 digits)");
    if (!/^\d{10}$/.test(parentMobile))
      missing.push("Parent's Mobile (10 digits)");
    if (!email) missing.push("Email");
    if (!place) missing.push("Center");
    if (!mode) missing.push("Mode");
    if (!agreed) missing.push("Terms & Conditions (checkbox)");
    if (!dataConsent) missing.push("Data Consent");  // ⬅️ NEW

    if (missing.length) {
      setError(`Please fill/verify: ${missing.join(", ")}.`);
      return;
    }

    // Student & Parent mobile must be different
    if (studMobile && parentMobile && studMobile === parentMobile) {
      setError("Student's Mobile and Parent's Mobile cannot be the same.");
      return;
    }

    // 10th education details required (row index 0)
    const tenth = form.education?.[0] || {};
    if (
      !tenth.qualification ||
      !tenth.school ||
      !tenth.year ||
      !tenth.percentage
    ) {
      setError(
        "Please fill all fields for 10th (SSC / Secondary School) in Educational Details."
      );
      return;
    }

    if (!photo) {
      setError("Passport photo is required.");
      return;
    }

    // 🔥 iOS Fix: Check file sizes before allowing submit
    if (isIOS) {
      const maxPhotoSize = 3 * 1024 * 1024; // 3MB
      const maxDocSize = 3 * 1024 * 1024;   // 3MB
      
      if (photo.size > maxPhotoSize) {
        setError(`Photo too large (${Math.round(photo.size / 1024 / 1024)}MB). iOS limit: 3MB. Please use 'Choose file' to select a smaller image.`);
        return;
      }
      if (panFile && panFile.size > maxDocSize) {
        setError(`PAN document too large (${Math.round(panFile.size / 1024 / 1024)}MB). iOS limit: 3MB per file.`);
        return;
      }
      if (aadhaarFile && aadhaarFile.size > maxDocSize) {
        setError(`Aadhaar document too large (${Math.round(aadhaarFile.size / 1024 / 1024)}MB). iOS limit: 3MB per file.`);
        return;
      }
    }

    if (!panFile) {
      setError("PAN card document is required.");
      return;
    }

    if (!aadhaarFile) {
      setError("Aadhaar / Driving License document is required.");
      return;
    }


    if (!hasSign(form.signatures.student.signDataUrl)) {
      setError("Student signature is required.");
      return;
    }

    const tcTextToUse = form.course.trainingOnly
      ? TRAINING_ONLY_TNC
      : TERMS_TEXT;

    setAdmissionDraft({
      payload: {
        ...form,
        personal: {
          ...form.personal,
          name,
          studentMobile: studMobile,
          whatsappMobile: waMobile,
          email,
        },
        tcText: tcTextToUse,
        tc: {
          accepted: true,
          version: form.tcVersion,
          text: tcTextToUse,
          type: form.course.trainingOnly ? "training-only" : "job-guarantee",
          dataConsentAccepted: form.dataConsentAccepted,   // ⬅️ optional but good
        },
        meta: {
          planType: form.course.trainingOnly ? "training" : "job",
          counselorKey, // ✅ NEW
        },

      },
      files: {
        photo,
        panFile,
        aadhaarFile,
        studentSign: form?.signatures?.student?.signDataUrl || "",
        parentSign: form?.signatures?.parent?.signDataUrl || "",
      },
    });

    nav(`/admission-otp?c=${counselorKey}`);
  };

  // 🔒 EDIT LINK EXPIRED UI
  if (error === "expired-link") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white border border-red-100 rounded-lg shadow p-6 text-center">
          <h2 className="text-xl font-semibold text-red-600 mb-2">
            Edit link expired
          </h2>
          <p className="text-sm text-gray-700 mb-1">
            This edit link is no longer active.
          </p>
          <p className="text-xs text-gray-500">
            Please contact your counselor for a new edit link.
          </p>
        </div>
      </div>
    );
  }

  const canEditStudentSign = isFieldEditable("signatures", "sg_student");
  const canEditParentSign = isFieldEditable("signatures", "sg_parent");

  return (
    <div className="min-h-screen">
      {/* Page/container: 80% width on lg+ */}
      <main className="mx-auto w-full sm:w-[96%] md:w-[94%] lg:w-[80%] xl:w-[80%] 2xl:w-[80%] max-w-[1920px] p-3 sm:p-6">
        {loading && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30">
            <div className="bg-white px-6 py-5 rounded-lg shadow-xl flex items-center gap-4">
              <span className="w-10 h-10 border-4 border-gray-300 border-t-gray-600 rounded-full animate-spin inline-block" />
              <span className="text-base font-semibold text-gray-700">
                {editMode ? "Saving changes…" : "Submitting…"}
              </span>
            </div>
          </div>
        )}

        <form
          onSubmit={submit}
          className="w-full p-4 sm:p-6 space-y-6 border bg-white rounded-lg shadow break-words"
        >
          {/* ---- logo ---- */}
          <img
            src="https://res.cloudinary.com/www-awdiz-in/image/upload/v1675932002/logo/awdiz.png"
            alt="AWDIZ Logo"
            className="mx-auto w-32 sm:w-36 mb-1"
          />

          {/* ---- title ---- */}
          <h1 className="text-2xl sm:text-3xl font-bold text-center">
            {editMode ? "AWDIZ Admission Form – Edit" : "AWDIZ Admission Form"}
          </h1>
          <p className="text-center text-xs sm:text-sm opacity-80">
            Bandra – Mumbai | Vashi Plaza – Navi Mumbai
          </p>

          {editMode && (
            <p className="text-center text-xs sm:text-sm text-blue-700 mb-2">
              You are editing your submitted admission form. The counselor will review only the sections selected for correction.
            </p>
          )}

          {error && error !== "expired-link" && (
            <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded">
              {error}
            </div>
          )}

          {/* ---------- PERSONAL ---------- */}
          <section className="space-y-2">
            <h2 className="text-lg sm:text-xl font-semibold">
              Personal Information
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex gap-2 min-w-0">
                <select
                  className="border p-2 rounded w-28 shrink-0"
                  value={form.personal.salutation}
                  disabled={!isFieldEditable("personal", "pf_fullName")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      personal: {
                        ...form.personal,
                        salutation: e.target.value,
                      },
                    })
                  }
                >
                  <option>Mr</option>
                  <option>Ms</option>
                  <option>Mrs</option>
                </select>
                <input
                  className={
                    "border p-2 rounded flex-1 min-w-0 " +
                    (isFieldHighlighted("personal", "pf_fullName")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  placeholder="Full Name*"
                  value={form.personal.name}
                  disabled={!isFieldEditable("personal", "pf_fullName")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      personal: { ...form.personal, name: e.target.value },
                    })
                  }
                  required
                />
              </div>

              <input
                className={
                  "border p-2 rounded w-full " +
                  (isFieldHighlighted("personal", "pf_guardian")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
                placeholder="Son/Daughter/Wife of Mr*"
                value={form.personal.fatherOrGuardianName}
                disabled={!isFieldEditable("personal", "pf_guardian")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    personal: {
                      ...form.personal,
                      fatherOrGuardianName: e.target.value,
                    },
                  })
                }
                required
              />

              <input
                className={
                  "border p-2 rounded sm:col-span-2 w-full " +
                  (isFieldHighlighted("personal", "pf_address")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
                placeholder="Address*"
                value={form.personal.address}
                disabled={!isFieldEditable("personal", "pf_address")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    personal: { ...form.personal, address: e.target.value },
                  })
                }
                required
              />

              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
                  +91
                </span>

                <input
                  className={
                    "border p-2 pl-12 rounded w-full " +
                    (isFieldHighlighted("personal", "pf_studentMobile")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  placeholder="Enter 10 digit mobile number*"
                  value={form.personal.studentMobile}
                  disabled={!isFieldEditable("personal", "pf_studentMobile")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      personal: {
                        ...form.personal,
                        studentMobile: e.target.value.replace(/\D/g, "").slice(0, 10),
                      },
                    })
                  }
                  required
                />
              </div>

              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
                  +91
                </span>
                <input
                  className={
                    "border p-2 pl-12 rounded w-full " +
                    (isFieldHighlighted("personal", "pf_whatsapp")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  placeholder="Student’s WhatsApp Mobile*"
                  value={form.personal.whatsappMobile}
                  disabled={!isFieldEditable("personal", "pf_whatsapp")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      personal: {
                        ...form.personal,
                        whatsappMobile: e.target.value.replace(/\D/g, "").slice(0, 10),
                      },
                    })
                  }
                  required
                />
              </div>
              <input
                className={
                  "border p-2 rounded w-full " +
                  (isFieldHighlighted("personal", "pf_email")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
                type="email"
                placeholder="Email ID*"
                value={form.personal.email}
                disabled={!isFieldEditable("personal", "pf_email")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    personal: { ...form.personal, email: e.target.value },
                  })
                }
                required
              />
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
                  +91
                </span>


                {/* Parent mobile */}
                <input
                  className={
                    "border p-2 pl-12 rounded sm:col-span-2 w-full " +
                    (isFieldHighlighted("personal", "pf_parentMobile")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  placeholder="Parent's Mobile*"
                  value={form.personal.parentMobile}
                  disabled={!isFieldEditable("personal", "pf_parentMobile")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      personal: {
                        ...form.personal,
                        parentMobile: e.target.value,
                      },
                    })
                  }
                  required
                />
              </div>
            </div>
          </section>

          {/* ---------- COURSE (with Plan radios) ---------- */}
          <section className="space-y-2">
            <h2 className="text-lg sm:text-xl font-semibold">
              Course Details
            </h2>

            {/* Row 1: Course select + reference */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select
                className={
                  "border p-2 rounded w-full " +
                  (isFieldHighlighted("course", "cr_name")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
                value={form.course.name}
                disabled={!isFieldEditable("course", "cr_name")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    course: {
                      ...form.course,
                      name: e.target.value,
                    },
                  })
                }
                required
              >
                <option value="">Select Course Enrolled</option>
                <option value="Network System Admin">Network System Admin</option>
                <option value="Hardware Networking">Hardware Networking</option>
                <option value="Windows Administrator">Windows Administrator</option>
                <option value="Full Stack (Mern)">Full Stack (Mern)</option>
                <option value="Java Full Stack Developer">
                  Java Full Stack Developer
                </option>
                <option value="Data Science with AI">Data Science with AI</option>
                <option value="Data Analytic">Data Analytic</option>
                <option value="Master Network Cloud Computing">
                  Master Network Cloud Computing
                </option>
                <option value="Master Network CyberSecurity">
                  Master Network CyberSecurity
                </option>
              </select>

              <input
                className={
                  "border p-2 rounded w-full " +
                  (isFieldHighlighted("course", "cr_reference")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
                placeholder="Reference of Friends/Colleagues/Relatives"
                value={form.course.reference || ""}
                disabled={!isFieldEditable("course", "cr_reference")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    course: { ...form.course, reference: e.target.value },
                  })
                }
              />
            </div>

            {/* Row 2: RADIO BUTTONS for Plan */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
              <label
                className={
                  "flex items-start gap-3 cursor-pointer select-none border rounded p-2 " +
                  (isFieldHighlighted("course", "cr_planType")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
              >
                <input
                  type="radio"
                  name="planType"
                  className="mt-1"
                  checked={!form.course.trainingOnly}
                  disabled={!isFieldEditable("course", "cr_planType")}
                  onChange={() =>
                    setForm({
                      ...form,
                      course: { ...form.course, trainingOnly: false },
                    })
                  }
                />
                <span className="min-w-0">
                  <b className="">Job Guarantee Training</b>
                </span>
              </label>

              <label
                className={
                  "flex items-start gap-3 cursor-pointer select-none border rounded p-2 " +
                  (isFieldHighlighted("course", "cr_planType")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
              >
                <input
                  type="radio"
                  name="planType"
                  className="mt-1"
                  checked={form.course.trainingOnly}
                  disabled={!isFieldEditable("course", "cr_planType")}
                  onChange={() =>
                    setForm({
                      ...form,
                      course: { ...form.course, trainingOnly: true },
                    })
                  }
                />
                <span className="min-w-0">
                  <b>Training only</b>
                </span>
              </label>
            </div>

            <p className="text-xs opacity-70">Tip: Select exactly one option.</p>
          </section>

          {/* ---------- EDUCATION ---------- */}
          <section className="space-y-2">
            <h2 className="text-lg sm:text-xl font-semibold">
              Educational Details
            </h2>

            {form.education.map((row, i) => {
              const placeholders = [
                {
                  qualification: "10th (SSC / Secondary School)",
                  school: "School / College Name",
                  year: "Year of Passing (e.g., 2018)",
                  percentage: "Marks / Grade (e.g., 85% or A)",
                },
                {
                  qualification: "12th (HSC / Higher Secondary)",
                  school: "School / College Name",
                  year: "Year of Passing (e.g., 2020)",
                  percentage: "Marks / Grade (e.g., 82% or B+)",
                },
                {
                  qualification: "Diploma / Stream",
                  school: "Institute Name / College Name",
                  year: "Year of Passing (e.g., 2021)",
                  percentage: "Marks / Grade (e.g., 80% or B)",
                },
                {
                  qualification: "Graduation / Stream",
                  school: "College / University",
                  year: "Year of Passing (e.g., 2024)",
                  percentage: "Marks / Grade (e.g., 75% or A)",
                },
              ];
              const defaultPlaceholder = {
                qualification: "Other Qualification (e.g., Certification)",
                school: "School / College / Institute",
                year: "Year of Passing",
                percentage: "Marks / Grade",
              };
              const ph = placeholders[i] || defaultPlaceholder;

              const qKey = `ed_q_${i}`;
              const sKey = `ed_s_${i}`;
              const yKey = `ed_y_${i}`;
              const pKey = `ed_p_${i}`;

              return (
                <div key={i} className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <input
                    className={
                      "border p-2 rounded w-full " +
                      (isFieldHighlighted("education", qKey)
                        ? "border-red-500 bg-red-50"
                        : "")
                    }
                    placeholder={ph.qualification}
                    value={row.qualification}
                    disabled={!isFieldEditable("education", qKey)}
                    onChange={(e) => {
                      const ed = [...form.education];
                      ed[i] = { ...ed[i], qualification: e.target.value };
                      setForm({ ...form, education: ed });
                    }}
                    required={!editMode && i === 0}
                  />
                  <input
                    className={
                      "border p-2 rounded w-full " +
                      (isFieldHighlighted("education", sKey)
                        ? "border-red-500 bg-red-50"
                        : "")
                    }
                    placeholder={ph.school}
                    value={row.school || ""}
                    disabled={!isFieldEditable("education", sKey)}
                    onChange={(e) => {
                      const ed = [...form.education];
                      ed[i] = { ...ed[i], school: e.target.value };
                      setForm({ ...form, education: ed });
                    }}
                    required={!editMode && i === 0}
                  />
                  <input
                    className={
                      "border p-2 rounded w-full " +
                      (isFieldHighlighted("education", yKey)
                        ? "border-red-500 bg-red-50"
                        : "")
                    }
                    placeholder={ph.year}
                    value={row.year}
                    disabled={!isFieldEditable("education", yKey)}
                    onChange={(e) => {
                      const ed = [...form.education];
                      ed[i] = { ...ed[i], year: e.target.value };
                      setForm({ ...form, education: ed });
                    }}
                    required={!editMode && i === 0}
                  />
                  <div className="flex gap-2 min-w-0">
                    <input
                      className={
                        "border p-2 rounded flex-1 min-w-0 " +
                        (isFieldHighlighted("education", pKey)
                          ? "border-red-500 bg-red-50"
                          : "")
                      }
                      placeholder={ph.percentage}
                      value={row.percentage}
                      disabled={!isFieldEditable("education", pKey)}
                      onChange={(e) => {
                        const ed = [...form.education];
                        ed[i] = { ...ed[i], percentage: e.target.value };
                        setForm({ ...form, education: ed });
                      }}
                      required={!editMode && i === 0}
                    />
                    {i >= 4 && (
                      <button
                        type="button"
                        onClick={() => rmEdu(i)}
                        className="px-3 border rounded shrink-0"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              onClick={addEdu}
              className="px-3 py-1 border rounded"
            >
              + Add Row
            </button>
          </section>

          {/* ---------- IDS ---------- */}
          <section className="space-y-2">
            <h2 className="text-lg sm:text-xl font-semibold">ID Details*</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                className={
                  "border p-2 rounded w-full " +
                  (isFieldHighlighted("ids", "id_pan")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
                placeholder="Permanent Account Number (PAN) *"
                value={form.ids.pan}
                required={!editMode}
                disabled={!isFieldEditable("ids", "id_pan")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    ids: { ...form.ids, pan: e.target.value },

                  })
                }
              />
              <input
                className={
                  "border p-2 rounded w-full " +
                  (isFieldHighlighted("ids", "id_aadhaar")
                    ? "border-red-500 bg-red-50"
                    : "")
                }
                placeholder="Aadhaar Card / Driving License Number *"
                value={form.ids.aadhaarOrDriving}
                required={!editMode}
                disabled={!isFieldEditable("ids", "id_aadhaar")}
                onChange={(e) =>
                  setForm({
                    ...form,
                    ids: { ...form.ids, aadhaarOrDriving: e.target.value },
                  })
                }
              />
            </div>
          </section>

          {/* ---------- UPLOADS (PHOTO MANDATORY for NEW only) ---------- */}
          <section className="space-y-2">
            <h2 className="text-lg sm:text-xl font-semibold">Uploads</h2>
            
            {/* 🔥 iOS Notice */}
            {isIOS && (
              <div className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded p-2">
                📱 iPhone/iPad users: Use "Choose file" instead of camera for better upload success. 
                Max 3MB per file. Use WiFi if possible.
              </div>
            )}
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="min-w-0">
                <label className="block text-sm mb-1">Passport photo*</label>

                {/* iOS: two labels (stable) */}
                {isIOS ? (
                  <div className="flex flex-wrap gap-2">
                    {/* Choose file (image + pdf) */}
                    <label
                      style={{ touchAction: "manipulation", WebkitTouchCallout: "none", userSelect: "none" }}
                      className={
                        "inline-flex items-center justify-center border rounded-lg px-3 py-2 cursor-pointer active:scale-95 transition-transform " +
                        (isFieldHighlighted("uploads", "up_photo") ? "border-red-500 bg-red-50" : "")
                      }
                    >
                      Choose file
                      <input
                        type="file"
                        accept="image/*,.pdf"
                        className="hidden"
                        disabled={!isFieldEditable("uploads", "up_photo")}
                        onChange={async (e) => {
                          try {
                            const file = e.target.files?.[0] || null;
                            if (!file) return;

                            setImageProcessing(true);
                            const normalized = await normalizeImageFile(file);
                            setImageProcessing(false);
                            
                            if (normalized) {
                              setPhoto(normalized);
                              setCapturedUrl("");
                              setTimeout(() => {
                                e.target.value = "";
                              }, 100);
                            }
                          } catch (err) {
                            setImageProcessing(false);
                            console.error("File upload error:", err);
                            setError("Failed to process file. Please try again.");
                            e.target.value = "";
                          }
                        }}
                      />
                    </label>

                    {/* Take photo (image only) */}
                    <label
                      style={{ touchAction: "manipulation", WebkitTouchCallout: "none", userSelect: "none" }}
                      className={
                        "inline-flex items-center justify-center border rounded-lg px-3 py-2 cursor-pointer active:scale-95 transition-transform " +
                        (isFieldHighlighted("uploads", "up_photo") ? "border-red-500 bg-red-50" : "")
                      }
                    >
                      Take photo
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        disabled={!isFieldEditable("uploads", "up_photo")}
                        onChange={async (e) => {
                          try {
                            const file = e.target.files?.[0] || null;
                            if (!file) {
                              alert("Camera Issue: No photo was captured.\n\nPossible causes:\n1. Camera permission denied in iOS Settings\n2. User cancelled the camera\n3. iOS memory issue\n\nTo fix:\n- Go to iOS Settings > Safari > Camera > Allow\n- Or use 'Choose file' instead");
                              return;
                            }

                            setImageProcessing(true);
                            const normalized = await normalizeImageFile(file);
                            setImageProcessing(false);
                            
                            if (normalized) {
                              setPhoto(normalized);
                              setCapturedUrl("");
                              setTimeout(() => {
                                e.target.value = "";
                              }, 100);
                            }
                          } catch (err) {
                            setImageProcessing(false);
                            console.error("iOS Camera error:", err);
                            setError("Failed to process camera photo. Please try again.");
                            e.target.value = "";
                          }
                        }}
                      />
                    </label>
                  </div>
                ) : (
                  /* Android + Desktop */
                  <div className="rounded-lg p-1 flex items-center gap-3 bg-white">
                    <select
                      className={
                        "border rounded-lg p-2 min-w-[150px] " +
                        (isFieldHighlighted("uploads", "up_photo") ? "border-red-500 bg-red-50" : "")
                      }
                      value={photoOption}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPhotoOption(""); // ✅ reset UI

                        if (v === "upload") {
                          // image + pdf
                          if (photoPickerRef.current) {
                            photoPickerRef.current.accept = "image/*,.pdf";
                            photoPickerRef.current.removeAttribute("capture");
                            photoPickerRef.current.click();
                          }
                          return;
                        }

                        if (v === "camera") {
                          // Android mobile -> native capture input; Desktop -> your custom modal
                          if (isMobile) {
                            if (photoCameraRef.current) {
                              photoCameraRef.current.accept = "image/*";
                              photoCameraRef.current.setAttribute("capture", "environment");
                              photoCameraRef.current.click();
                            }
                          } else {
                            openCamera(); // ✅ your existing desktop camera modal
                          }
                        }
                      }}
                      disabled={!isFieldEditable("uploads", "up_photo")}
                    >
                      <option value="">Select option</option>
                      <option value="upload">Choose file</option>
                      <option value="camera">Take photo</option>
                    </select>

                    {/* choose file input */}
                    <input
                      ref={photoPickerRef}
                      type="file"
                      accept="image/*,.pdf"
                      className="hidden"
                      disabled={!isFieldEditable("uploads", "up_photo")}
                      onChange={async (e) => {
                        const file = e.target.files?.[0] || null;
                        if (!file) return;

                        setImageProcessing(true);
                        const normalized = await normalizeImageFile(file);
                        setImageProcessing(false);
                        setPhoto(normalized);
                        setCapturedUrl("");
                        e.target.value = "";
                      }}

                    />

                    {/* take photo input */}
                    <input
                      ref={photoCameraRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      disabled={!isFieldEditable("uploads", "up_photo")}
                      onChange={async (e) => {
                        const file = e.target.files?.[0] || null;
                        if (!file) return;

                        setImageProcessing(true);
                        const normalized = await normalizeImageFile(file);
                        setImageProcessing(false);
                        setPhoto(normalized);
                        setCapturedUrl("");
                        e.target.value = "";
                      }}

                    />
                  </div>
                )}

                {/* Preview */}
                {(capturedUrl || photo) && (
                  <div className="mt-2">
                    {photo?.type === "application/pdf" ? (
                      <p className="text-sm border rounded p-2 text-green-700">
                        📄 PDF selected: {photo.name}
                      </p>
                    ) : (
                      <img
                        alt="Selected passport"
                        className="h-28 w-28 object-cover rounded border"
                        src={capturedUrl || (photo ? URL.createObjectURL(photo) : "")}
                        onLoad={(e) => {
                          if (photo && e.currentTarget.src.startsWith("blob:")) {
                            URL.revokeObjectURL(e.currentTarget.src);
                          }
                        }}
                      />
                    )}
                  </div>
                )}
              </div>






              <div className="min-w-0">
                <label className="block text-sm mb-1">PAN (image/pdf)*</label>
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={async (e) => {
                    const file = e.target.files?.[0] || null;
                    if (!file) return;

                    setImageProcessing(true);
                    const normalized = await normalizeImageFile(file);
                    setImageProcessing(false);
                    setPanFile(normalized);
                  }}

                  className={
                    "w-full border rounded p-1 " +
                    (isFieldHighlighted("uploads", "up_pan")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  disabled={!isFieldEditable("uploads", "up_pan")}
                  required={!editMode}
                />
              </div>
              <div className="min-w-0">
                <label className="block text-sm mb-1">
                  Aadhaar/Driving (image/pdf)*
                </label>
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={async (e) => {
                    const file = e.target.files?.[0] || null;
                    if (!file) return;

                    setImageProcessing(true);
                    const normalized = await normalizeImageFile(file);
                    setImageProcessing(false);
                    setAadhaarFile(normalized);
                  }}

                  className={
                    "w-full border rounded p-1 " +
                    (isFieldHighlighted("uploads", "up_aadhaar")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  disabled={!isFieldEditable("uploads", "up_aadhaar")}
                  required={!editMode}
                />
              </div>
            </div>
          </section>

          {/* ---------- CENTER ---------- */}
          <section className="space-y-2">
            <h2 className="text-lg sm:text-xl font-semibold">Center</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="min-w-0">
                <label className="block text-sm mb-1">
                  Place of Admission*
                </label>
                <select
                  className={
                    "border p-2 rounded w-full " +
                    (isFieldHighlighted("center", "center_place")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  value={form.center.placeOfAdmission}
                  disabled={!isFieldEditable("center", "center_place")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      center: {
                        ...form.center,
                        placeOfAdmission: e.target.value,
                      },
                    })
                  }
                  required
                >
                  <option value="">Select Location</option>
                  <option value="Bandra">Bandra</option>
                  <option value="Vashi">Vashi</option>
                </select>
              </div>
              <div className="min-w-0">
                <label className="block text-sm mb-1">Mode*</label>
                <select
                  className={
                    "border p-2 rounded w-full " +
                    (isFieldHighlighted("center", "center_mode")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  value={form.center.mode}
                  disabled={!isFieldEditable("center", "center_mode")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      center: { ...form.center, mode: e.target.value },
                    })
                  }
                  required
                >
                  <option value="">Select Mode</option>
                  <option value="Online">Online</option>
                  <option value="Offline">Offline</option>
                  <option value="Hybrid">Hybrid</option>
                </select>
              </div>
            </div>
          </section>

          {/* ---------- SIGNATURES ---------- */}
          <section className="space-y-2">
            <h2 className="text-lg sm:text-xl font-semibold">Signatures</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="min-w-0">
                <label className="block text-sm mb-1">
                  STUDENT FULL NAME*
                </label>
                <input
                  className={
                    "border p-2 rounded w-full " +
                    (isFieldHighlighted("signatures", "sg_student")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  value={form.signatures.student.fullName}
                  disabled={!canEditStudentSign}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      signatures: {
                        ...form.signatures,
                        student: {
                          ...form.signatures.student,
                          fullName: e.target.value,
                        },
                      },
                    })
                  }
                  required
                />
                <div className="mt-2">
                  <SignaturePad
                    value={form.signatures.student.signDataUrl}
                    onChange={(d) => {
                      if (!canEditStudentSign) return;
                      setForm({
                        ...form,
                        signatures: {
                          ...form.signatures,
                          student: {
                            ...form.signatures.student,
                            signDataUrl: d,
                          },
                        },
                      });
                    }}
                    required
                  />
                  {hasSign(form.signatures.student.signDataUrl) && (
                    <span className="text-xs text-green-700">
                      ✓ Signature saved
                    </span>
                  )}
                </div>
              </div>
              <div className="min-w-0">
                <label className="block text-sm mb-1">
                  PARENT/GUARDIAN FULL NAME*
                </label>
                <input
                  className={
                    "border p-2 rounded w-full " +
                    (isFieldHighlighted("signatures", "sg_parent")
                      ? "border-red-500 bg-red-50"
                      : "")
                  }
                  value={form.signatures.parent.fullName}
                  disabled={!canEditParentSign}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      signatures: {
                        ...form.signatures,
                        parent: {
                          ...form.signatures.parent,
                          fullName: e.target.value,
                        },
                      },
                    })
                  }
                  required
                />
                <div className="mt-2">
                  <SignaturePad
                    value={form.signatures.parent.signDataUrl}
                    onChange={(d) => {
                      if (!canEditParentSign) return;
                      setForm({
                        ...form,
                        signatures: {
                          ...form.signatures,
                          parent: {
                            ...form.signatures.parent,
                            signDataUrl: d,
                          },
                        },
                      });
                    }}
                    required
                  />
                </div>
              </div>
            </div>
            <p className="text-xs opacity-70">
              {editMode
                ? "Note: Student signature was already captured in your original submission."
                : "Note: Student signature is mandatory for submission."}
            </p>
          </section>

          {/* ---------- TERMS (conditional) ---------- */}
          <section className="space-y-2">
            <h2 className="text-lg sm:text-xl font-semibold">
              {form.course.trainingOnly
                ? "Training Terms & Conditions"
                : "Job Guarantee Terms & Conditions"}
            </h2>

            {form.course.trainingOnly ? (
              <div className="border rounded p-3 bg-gray-50 whitespace-pre-line">
                {TRAINING_ONLY_TNC}
              </div>
            ) : (
              <div className="border rounded p-3 h-56 overflow-y-auto bg-gray-50">
                <TermsAndConditions />
              </div>
            )}

            {/* ✅ Existing first checkbox (same as before) */}
            <label className="flex items-center gap-2 mt-2 text-sm">
              <input
                type="checkbox"
                checked={form.termsAccepted}
                onChange={(e) =>
                  setForm({ ...form, termsAccepted: e.target.checked })
                }
                required={!editMode}
              />
              <span>
                I have read and agree to the{" "}
                {form.course.trainingOnly ? "Training-only" : "Job-Guarantee"}{" "}
                Terms &amp; Conditions.
              </span>
            </label>

            {/* ✅ NEW: Data consent checkbox with paragraph (required) */}
            <label className="flex items-start gap-2 mt-2 text-sl">
              <input
                type="checkbox"
                checked={form.dataConsentAccepted}
                onChange={(e) =>
                  setForm({ ...form, dataConsentAccepted: e.target.checked })
                }
                required={!editMode}
              />
              <span className="text-base font-semibold">
                By submitting this admission form, I hereby give consent to the
                institution to collect and store my personal information, including my
                photograph and identity documents, for admission and administrative
                purposes. I understand that my documents and photos may be securely stored
                on third-party cloud platforms and that my personal data may be recorded
                in digital storage systems for processing and record-keeping. I
                acknowledge that this information will be used only for verification,
                internal administration, and legally required processes, and will not be
                shared with unauthorized parties. I further understand that the institution
                will take reasonable measures to protect my data, and that I may request
                correction or deletion of my information as per institutional and legal
                guidelines. By proceeding, I voluntarily agree to these terms and
                conditions.
              </span>
            </label>
          </section>
          <div>
            <button
              disabled={loading}
              className="bg-black text-white px-5 py-2 rounded w-full sm:w-auto"
            >
              {loading
                ? editMode
                  ? "Saving Changes…"
                  : "Submitting…"
                : editMode
                  ? "Save Changes"
                  : "Submit"}
            </button>
          </div>
        </form>
      </main>

      {/* ============== CAMERA MODAL ============== */}
      {cameraOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-[680px] p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">Take Passport Photo</h3>
              <button
                onClick={handleCloseCamera}
                className="px-3 py-1 border rounded"
              >
                Close
              </button>
            </div>

            <div className="w-full aspect-video bg-black/90 rounded overflow-hidden flex items-center justify-center">
              {capturedUrl ? (
                <img
                  src={capturedUrl}
                  alt="Captured"
                  className="max-h-full object-contain"
                />
              ) : (
                <video
                  key={videoKey}
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-contain"
                />
              )}
            </div>

            <canvas ref={canvasRef} className="hidden" />

            <div className="mt-3 flex flex-wrap gap-2">
              {!capturedUrl ? (
                <button
                  onClick={handleCapture}
                  type="button"
                  className="px-4 py-2 bg-black text-white rounded"
                >
                  Capture
                </button>
              ) : (
                <>
                  <button
                    onClick={handleRetake}
                    type="button"
                    className="px-4 py-2 border rounded"
                  >
                    Retake
                  </button>
                  <button
                    onClick={handleUsePhoto}
                    type="button"
                    className="px-4 py-2 bg-black text-white rounded"
                  >
                    Use Photo
                  </button>
                </>
              )}
            </div>

            <p className="text-xs opacity-70 mt-2">
              Tip: Good lighting & neutral background recommended.
            </p>
          </div>
        </div>
      )}
      {/* ============ /CAMERA MODAL ============ */}
    </div>
  );
}
