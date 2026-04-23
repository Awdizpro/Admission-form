import multer from "multer";
import path from "path";

const storage = multer.memoryStorage();

const MAX_MB = 50;
const fileSize = MAX_MB * 1024 * 1024;
const FIELD_SIZE = 25 * 1024 * 1024;

const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".heic", ".heif", ".raw", ".cr2", ".nef", ".arw"]);
const docExts = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt"]);
const allowedExts = new Set([...imageExts, ...docExts]);

function safeFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  if (mime.startsWith("image/")) return cb(null, true);
  if (mime === "application/pdf") return cb(null, true);
  if (mime === "application/octet-stream" && (ext === ".pdf" || imageExts.has(ext))) return cb(null, true);
  if (mime === "application/msword" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return cb(null, true);
  if (mime === "application/vnd.ms-excel" || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return cb(null, true);
  if (mime === "text/plain") return cb(null, true);
  
  if (allowedExts.has(ext)) return cb(null, true);

  return cb(
    new multer.MulterError(
      "LIMIT_UNEXPECTED_FILE",
      `Unsupported file type: ${file.originalname} (${file.mimetype})`
    )
  );
}

export const uploadAdmissionFiles = multer({
  storage,
  limits: { 
    fileSize,
    fieldSize: FIELD_SIZE,
  },
  fileFilter: safeFileFilter,
}).fields([
  { name: "photo", maxCount: 1 },
  { name: "panFile", maxCount: 1 },
  { name: "aadhaarFile", maxCount: 1 },
]);
