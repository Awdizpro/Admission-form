// import express from 'express';
// import cors from 'cors';
// import morgan from 'morgan';
// import admissionRoutes from './routes/admission.routes.js';
// const app = express();
// app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
// app.use(morgan('dev'));
// app.use(express.json());
// app.get('/api/health', (_req,res)=>res.json({ok:true}));
// app.use('/api/admissions', admissionRoutes);
// export default app;


// // server/src/app.js
// import express from "express";
// import cors from "cors";
// import morgan from "morgan";
// import admissionRoutes from "./routes/admissions.routes.js";

// const app = express();

// app.use(morgan("dev"));
// app.use(express.json());

// // ✅ CORS: allow localhost + any 192.168.* + your domains
// const allowed = [
//   process.env.CLIENT_ORIGIN, // http://localhost:3002
// ];

// app.use(
//   cors({
//     origin: (origin, cb) => {
//       // Postman / server-to-server / same-origin cases
//       if (!origin) return cb(null, true);

//       // ✅ allow exact matches
//       if (allowed.includes(origin)) return cb(null, true);

//       // ✅ allow local LAN origins like http://192.168.x.x:3002
//       if (/^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin)) return cb(null, true);

//       // ✅ allow production domains if needed
//       if (/^https?:\/\/(www\.)?awdizplacements\.in$/.test(origin)) return cb(null, true);

//       return cb(new Error("CORS blocked: " + origin), false);
//     },
//     credentials: true,
//   })
// );

// app.get("/api/health", (_req, res) => res.json({ ok: true }));

// // ✅ mount routes once
// app.use("/api/admissions", admissionRoutes);

// export default app;



// server/src/app.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import admissionRoutes from "./routes/admissions.routes.js";

const app = express();

app.use(morgan("dev"));

// ✅ JSON + URLENCODED (forms / HTML submit) both
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/**
 * ✅ CORS (NO BLOCK) + works with credentials
 * - Localhost, LAN IP, Production subdomain, ANY origin allowed
 * - We do NOT use "*" because credentials=true ke saath "*" invalid hota hai
 * - Instead: reflect the incoming Origin
 */
app.use(
  cors({
    origin: (origin, cb) => {
      // server-to-server / curl / Postman / same-origin
      if (!origin) return cb(null, true);

      // ✅ allow everything (no block)
      return cb(null, origin);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ Preflight support (some phones/browsers are strict)
app.options("*", cors());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ mount routes once
app.use("/api/admissions", admissionRoutes);

export default app;
