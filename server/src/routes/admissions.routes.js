

// server/src/routes/admissions.routes.js
import express from "express";
import multer from "multer";
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
const upload = multer({ storage: multer.memoryStorage() });

// ✅ Admission init (with file uploads)
router.post(
  "/init",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "pan", maxCount: 1 },
    { name: "aadhaar", maxCount: 1 },
  ]),
  initAdmission
);

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
