// server/src/app.js
// import express from "express";
// import cors from "cors";
// import morgan from "morgan";
// import admissionRoutes from "./routes/admissions.routes.js";

// const app = express();

// app.use(morgan("dev"));

// // ✅ JSON + URLENCODED (forms / HTML submit) both
// app.use(express.json({ limit: "10mb" }));
// app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// /**
//  * ✅ CORS (NO BLOCK) + works with credentials
//  * - Localhost, LAN IP, Production subdomain, ANY origin allowed
//  * - We do NOT use "*" because credentials=true ke saath "*" invalid hota hai
//  * - Instead: reflect the incoming Origin
//  */
// app.use(
//   cors({
//     origin: (origin, cb) => {
//       // server-to-server / curl / Postman / same-origin
//       if (!origin) return cb(null, true);

//       // ✅ allow everything (no block)
//       return cb(null, origin);
//     },
//     credentials: true,
//     methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//   })
// );

// // ✅ Preflight support (some phones/browsers are strict)
// app.options("*", cors());

// app.get("/api/health", (_req, res) => res.json({ ok: true }));

// // ✅ mount routes once
// app.use("/api/admissions", admissionRoutes);

// export default app;

// server/src/app.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";
import admissionRoutes from "./routes/admissions.routes.js";

const app = express();

app.use(morgan("dev"));

// ✅ JSON + URLENCODED
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

/* =====================================================
   ✅ CORS (safe + phone friendly) + FIXED PREFLIGHT
   - SAME options used for app.use + app.options
   - allowedHeaders expanded to avoid random preflight blocks
===================================================== */
const corsOptions = {
  origin: (origin, cb) => {
    // ✅ Mobile/LAN + server-to-server requests may have no origin
    if (!origin) return cb(null, true);
    // ✅ Reflect requesting origin (works for multiple domains / IPs)
    return cb(null, origin);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
  ],
};

app.use(cors(corsOptions));

// ✅ Preflight (IMPORTANT: same corsOptions)
app.options("*", cors(corsOptions));

/* =====================================================
   🔥 REQUEST LOGGER (helps debug OTP/CORS issues)
===================================================== */
app.use((req, _res, next) => {
  console.log(
    "➡️ INCOMING:",
    req.method,
    req.originalUrl,
    "| Origin:",
    req.headers.origin || "NO-ORIGIN"
  );
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ Routes
app.use("/api/admissions", admissionRoutes);

/* =====================================================
   🔥 MULTER + GLOBAL ERROR HANDLER
===================================================== */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error("🔥 MULTER ERROR:", err.code, err.message);
    return res.status(400).json({
      message:
        err.code === "LIMIT_FILE_SIZE"
          ? "Uploaded file is too large. Please upload a smaller PDF (max 15MB)."
          : err.code === "LIMIT_UNEXPECTED_FILE"
          ? "Unexpected file field. Please re-upload the document."
          : "File upload failed. Please try again.",
    });
  }

  if (err) {
    console.error("🔥 SERVER ERROR:", err);
    return res.status(500).json({
      message: "Server error during upload. Please try again.",
    });
  }

  next();
});

export default app;
