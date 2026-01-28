// server/src/routes/admission.routes.js
import express from "express";
import multer from "multer";
import { initAdmission, dummyVerifyAdmissionOtp} from "../controllers/admission.controller.js";

const router = express.Router();
// const upload = multer({
//   limits: {
//     fieldSize: 10 * 1024 * 1024, // 10MB for big data URLs
//     files: 6,
//     parts: 30,
//   },
// });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,      // 🔥 2MB PER FILE (mobile-safe)
    fieldSize: 10 * 1024 * 1024,    // for base64/signature
    files: 6,
    parts: 30,
  },
});


router.post(
  "/init",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "pan", maxCount: 1 },
    { name: "aadhaar", maxCount: 1 },
  ]),
  initAdmission
);

router.post("/verify-dummy", express.json(), dummyVerifyAdmissionOtp);
// // router.get("/admissions/:id/approve", approveAdmission); // admin-only (protect later)
// router.get("/:id/approve", approveAdmission);
export default router;
