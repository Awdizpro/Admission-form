// server/src/services/counselorRouting.service.js

const listFromEnv = (k) =>
  String(process.env[k] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function adminEmails() {
  return listFromEnv("ADMIN_COUNSELOR_EMAILS");
}

export function counselorEmailsByKey(counselorKey) {
  if (counselorKey === "c1") return listFromEnv("COUNSELOR_1_EMAILS");
  if (counselorKey === "c2") return listFromEnv("COUNSELOR_2_EMAILS");
  return []; // fallback
}

/**
 * Routing rule:
 * - Vashi -> c1
 * - Bandra -> c2
 * (Tum chaaho to later round-robin / percentage routing kar denge)
 */
export function pickCounselorKeyFromCenter(placeOfAdmission) {
  const center = String(placeOfAdmission || "").toLowerCase();
  if (center.includes("vashi")) return "c1";
  if (center.includes("bandra")) return "c2";
  return "c1"; // default
}
