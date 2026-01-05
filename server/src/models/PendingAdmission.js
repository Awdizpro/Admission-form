//server/src/models/PendingAdmission.js (15/11/2025)

import mongoose from "mongoose";

const PendingAdmissionSchema = new mongoose.Schema({
  mobile: { type: String, required: true, index: true },
  email:  { type: String, required: true },

  payload: { type: Object, required: true },

  uploads: {
    photoUrl: String,
    panUrl: String,
    aadhaarUrl: String,
    signatures: {
      studentSignUrl: String,
      parentSignUrl: String
    }
  },

  // 🔐 NEW FIELDS FOR 2-STEP OTP
  mobileOtpHash: { type: String, required: true },
  emailOtpHash:  { type: String, required: true },

  mobileVerified: { type: Boolean, default: false },
  emailVerified:  { type: Boolean, default: false },

  otpExpiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ["PENDING", "VERIFIED", "EXPIRED"],
    default: "PENDING"
  },
}, { timestamps: true });

// Auto-delete after 60 min
PendingAdmissionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 });

export default mongoose.model("PendingAdmission", PendingAdmissionSchema);
