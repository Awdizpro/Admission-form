//server/src/services/otp.service.js
import crypto from "crypto";

const DIGITS = "0123456789";

export function generateOtp(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += DIGITS[Math.floor(Math.random() * 10)];
  return s;
}

// HMAC hash (bcrypt bhi use kar sakte ho; HMAC light & fast hai)
export function hashOtp(otp) {
  const secret = process.env.OTP_HASH_SECRET || "dev-secret";
  return crypto.createHmac("sha256", secret).update(String(otp)).digest("hex");
}

export function verifyOtp(otp, otpHash) {
  return hashOtp(otp) === otpHash;
}
