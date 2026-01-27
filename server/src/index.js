// // server/src/index.js
// import "dotenv/config";
// import mongoose from "mongoose";
// import app from "./app.js";
// import admissionsRoutes from "./routes/admissions.routes.js";
// import { sendAdmissionEmails } from "./services/email.service.js";
// import { uploadBuffer } from "./services/storage.service.js";
// import express from "express";

// const port = process.env.PORT || 5002;
// const mongoUri = process.env.MONGO_URI;

// if (!mongoUri) {
//   console.error("❌ MONGO_URI is missing. Create server/.env and set MONGO_URI.");
//   process.exit(1);
// }

// // Health check
// app.get("/api/health", (_req, res) => res.json({ ok: true }));

// // ✅ ONLY ONCE: Admissions routes mounted under /api/admissions
// app.use("/api/admissions", admissionsRoutes);

// // Static PDFs
// // app.use("/files", express.static("storage/pdfs"));

// // (Optional) test endpoints you already had...
// app.get("/api/test-email", async (_req, res) => {
//   try {
//     const payload = {
//       personal: { name: "Test Student", studentMobile: "9999999999", email: process.env.FROM_EMAIL },
//       course: { name: "Test Course" },
//     };
//     await sendAdmissionEmails({
//       studentEmail: process.env.FROM_EMAIL,
//       pdfUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
//       payload,
//     });
//     res.json({ ok: true, message: "Email sent. Check inbox/spam." });
//   } catch (e) {
//     console.error("Test email error:", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// app.get("/api/test-cloudinary", async (_req, res) => {
//   const buf = Buffer.from("hello awdiz");
//   const result = await uploadBuffer({
//     buffer: buf,
//     folder: "awdiz/test",
//     publicId: `ping-${Date.now()}`,
//     resource_type: "image",
//     extra: { format: "txt" },
//   });
//   res.json({ ok: true, url: result.secure_url });
// });


// (async () => {
//   try {
//     await mongoose.connect(mongoUri);
//     console.log("✅ MongoDB connected");
//     app.listen(port, () => console.log(`API on http://localhost:${port}`));
//   } catch (e) {
//     console.error("❌ Failed to start server:", e.message);
//     process.exit(1);
//   }
// })();


// // server/src/index.js
// import "dotenv/config";
// import mongoose from "mongoose";
// import app from "./app.js";
// import { sendAdmissionEmails } from "./services/email.service.js";
// import { uploadBuffer } from "./services/storage.service.js";

// const port = process.env.PORT || 5002;
// const mongoUri = process.env.MONGO_URI;

// if (!mongoUri) {
//   console.error("❌ MONGO_URI is missing. Create server/.env and set MONGO_URI.");
//   process.exit(1);
// }

// // (Optional) test endpoints you already had...
// app.get("/api/test-email", async (_req, res) => {
//   try {
//     const payload = {
//       personal: {
//         name: "Test Student",
//         studentMobile: "9999999999",
//         email: process.env.FROM_EMAIL,
//       },
//       course: { name: "Test Course" },
//     };

//     await sendAdmissionEmails({
//       studentEmail: process.env.FROM_EMAIL,
//       pdfUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
//       payload,
//     });

//     res.json({ ok: true, message: "Email sent. Check inbox/spam." });
//   } catch (e) {
//     console.error("Test email error:", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// app.get("/api/test-cloudinary", async (_req, res) => {
//   const buf = Buffer.from("hello awdiz");
//   const result = await uploadBuffer({
//     buffer: buf,
//     folder: "awdiz/test",
//     publicId: `ping-${Date.now()}`,
//     resource_type: "image",
//     extra: { format: "txt" },
//   });
//   res.json({ ok: true, url: result.secure_url });
// });

// (async () => {
//   try {
//     await mongoose.connect(mongoUri);
//     console.log("✅ MongoDB connected");

//     // ✅ IMPORTANT: phone/LAN access ke liye
//     // ✅ bind to all interfaces so phone can reach it
//     app.listen(port, "0.0.0.0", () => {
//       console.log(`✅ API running on: http://localhost:${port}`);
//       console.log(`✅ LAN API example: http://192.168.31.6:${port} (use your PC IP)`);
//     });
//   } catch (e) {
//     console.error("❌ Failed to start server:", e.message);
//     process.exit(1);
//   }
// })();


//try

// server/src/index.js
import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";
import { sendAdmissionEmails } from "./services/email.service.js";
import { uploadBuffer } from "./services/storage.service.js";

const port = process.env.PORT || 5002;
const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
  console.error("❌ MONGO_URI is missing. Create server/.env and set MONGO_URI.");
  process.exit(1);
}

// (Optional) test endpoints you already had...
app.get("/api/test-email", async (_req, res) => {
  try {
    const payload = {
      personal: {
        name: "Test Student",
        studentMobile: "9999999999",
        email: process.env.FROM_EMAIL,
      },
      course: { name: "Test Course" },
    };

    await sendAdmissionEmails({
      studentEmail: process.env.FROM_EMAIL,
      pdfUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
      payload,
    });

    res.json({ ok: true, message: "Email sent. Check inbox/spam." });
  } catch (e) {
    console.error("Test email error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/test-cloudinary", async (_req, res) => {
  const buf = Buffer.from("hello awdiz");
  const result = await uploadBuffer({
    buffer: buf,
    folder: "awdiz/test",
    publicId: `ping-${Date.now()}`,
    resource_type: "image",
    extra: { format: "txt" },
  });
  res.json({ ok: true, url: result.secure_url });
});

(async () => {
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ MongoDB connected");

    // ✅ bind to all interfaces (phone/LAN access)
    app.listen(port, "0.0.0.0", () => {
      console.log(`✅ API running on: http://localhost:${port}`);
      console.log(`✅ If phone testing: use your PC IP like http://192.168.xx.xx:${port}`);
    });
  } catch (e) {
    console.error("❌ Failed to start server:", e.message);
    process.exit(1);
  }
})();
