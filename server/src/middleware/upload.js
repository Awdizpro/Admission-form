// server/src/middleware/upload.js
// import multer from 'multer';
// export const upload = multer({ storage: multer.memoryStorage(), limits:{ fileSize: 5*1024*1024 } });

// server/src/middleware/upload.js
import multer from "multer";

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024,  // 30MB
    fieldSize: 25 * 1024 * 1024,
    files: 6,
    parts: 80,
  },
});
