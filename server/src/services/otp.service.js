import crypto from "crypto";

const DIGITS = "0123456789";

export function generateOtp(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += DIGITS[Math.floor(Math.random() * 10)];
  return s;
}

export function hashOtp(otp) {
  if (!otp) return "";
  const secret = process.env.OTP_HASH_SECRET || "dev-secret";
  return crypto.createHmac("sha256", secret).update(String(otp)).digest("hex");
}

export function verifyOtp(otp, otpHash) {
  if (!otp || !otpHash) return false;
  const computed = hashOtp(otp);
  return computed === otpHash;
}
