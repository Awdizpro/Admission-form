import multer from "multer";
import path from "path";

const storage = multer.memoryStorage(); // phone friendly, avoids disk path issues

const MAX_MB = 15;
const fileSize = MAX_MB * 1024 * 1024;

// Allowed extensions (fallback when mimetype is weird)
const allowedExt = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);

function safeFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  const isImageMime = mime.startsWith("image/");
  const isPdfMime = mime === "application/pdf";
  const isOctetStream = mime === "application/octet-stream"; // common on phones

  // ✅ Accept images
  if (isImageMime) return cb(null, true);

  // ✅ Accept PDF by mimetype
  if (isPdfMime) return cb(null, true);

  // ✅ Phone fallback: octet-stream but extension .pdf
  if (isOctetStream && ext === ".pdf") return cb(null, true);

  // ✅ Extension fallback (some browsers send empty mimetype)
  if (allowedExt.has(ext)) return cb(null, true);

  return cb(
    new multer.MulterError(
      "LIMIT_UNEXPECTED_FILE",
      `Unsupported file type: ${file.originalname} (${file.mimetype})`
    )
  );
}

export const uploadAdmissionFiles = multer({
  storage,
  limits: { fileSize },
  fileFilter: safeFileFilter,
}).fields([
  { name: "photo", maxCount: 1 },
  { name: "panFile", maxCount: 1 },
  { name: "aadhaarFile", maxCount: 1 },
]);
