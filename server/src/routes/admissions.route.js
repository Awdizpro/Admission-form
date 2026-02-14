// server/src/routes/admissions.routes.js
import express from "express";
import multer from "multer";
import { initAdmission, verifyAdmissionOtp } from "../controllers/admission.controller.js";
import { checkAdmissionStatus } from "../controllers/admission.otp.controller.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// INIT = receives form + files, generates/sends OTP, returns pendingId
router.post(
  "/init",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "pan", maxCount: 1 },
    { name: "aadhaar", maxCount: 1 },
  ]),
  initAdmission
);

// VERIFY = receives { pendingId, otp }, finalizes PDF+email+DB
router.post("/verify", express.json(), verifyAdmissionOtp);

// CHECK STATUS = Check if admission was successful after network error
router.get("/check-status/:pendingId", checkAdmissionStatus);

export default router;
