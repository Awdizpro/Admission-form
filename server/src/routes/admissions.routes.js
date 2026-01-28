

// server/src/routes/admissions.routes.js
import express from "express";
import multer from "multer";
import { uploadAdmissionFiles } from "../middleware/uploadAdmission.js";
import {
  initAdmission,
  dummyVerifyAdmissionOtp,
  approveAdmission,
  reviewAdmissionPage,
  adminReviewAdmissionPage, 
  requestEditToCounselor,  
  requestEditAdmission,
  getAdmissionForEdit,
  applyAdmissionEdit,

  // ✅ NEW: counselor submits to admin (fees + mode)
  submitToAdmin,  
} from "../controllers/admission.controller.js";


const router = express.Router();
// const upload = multer({ storage: multer.memoryStorage() });

const upload = multer({
  storage: multer.memoryStorage(),
   limits: {
    fileSize: 35 * 1024 * 1024,    // ✅ PDFs ke liye safe
    fieldSize: 25 * 1024 * 1024,   // ✅ base64 signatures safe
    files: 3,
    parts: 80,
  },
});

// ✅ Admission init (with file uploads)
const initUpload = upload.fields([
  { name: "photo", maxCount: 1 },
  { name: "pan", maxCount: 1 },
  { name: "aadhaar", maxCount: 1 },
]);

router.post("/init", (req, res, next) => {
  initUpload(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ message: "File too large. Upload under 35MB." });
      }
      if (err.code === "LIMIT_PART_COUNT") {
        return res.status(413).json({ message: "Too many form parts. Try again." });
      }
      return res.status(400).json({ message: err.message || "Upload failed" });
    }
    next();
  });
}, initAdmission);
// ✅ Just to debug uploads (optional but useful)
router.post("/debug-upload", uploadAdmissionFiles, (req, res) => {
  const files = req.files || {};
  const out = Object.fromEntries(
    Object.entries(files).map(([k, arr]) => [
      k,
      arr.map((f) => ({
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
      })),
    ])
  );

  return res.json({ ok: true, files: out });
});

// ✅ OTP verification (aliases)
router.post("/verify-dummy", express.json(), dummyVerifyAdmissionOtp);
router.post("/verify", express.json(), dummyVerifyAdmissionOtp);

// ⭐ NEW: COUNSELOR REVIEW PAGE (HTML with PDF + buttons)
router.get("/:id/review", reviewAdmissionPage);
router.get("/:id/admin-review", adminReviewAdmissionPage);

// ⭐ NEW: REQUEST EDIT (HTML form submit from counselor review)
router.post(
  "/:id/request-edit",
  express.urlencoded({ extended: true }),
  requestEditAdmission
);

// ✅ NEW: COUNSELOR -> SUBMIT TO ADMIN (fees required + cash/online required)
router.post(
  "/:id/submit-to-admin",
  express.urlencoded({ extended: true }),
  submitToAdmin
);

// ✅ APPROVE endpoint (this is the one your email button hits)
// router.get("/:id/approve", approveAdmission);
router.post("/:id/approve", approveAdmission);

// 🔹 Student edit ke liye data fetch
router.get("/:id/edit-data", getAdmissionForEdit);

// 🔹 Student ne edit submit kiya
router.post("/:id/apply-edit", express.json(), applyAdmissionEdit);


router.post("/:id/request-edit-counselor", requestEditToCounselor);



export default router;
