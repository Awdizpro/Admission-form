// server/src/index.js
import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";
import admissionsRoutes from "./routes/admissions.routes.js";
import { sendAdmissionEmails } from "./services/email.service.js";
import { uploadBuffer } from "./services/storage.service.js";
import express from "express";

const port = process.env.PORT || 5002;
const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
  console.error("❌ MONGO_URI is missing. Create server/.env and set MONGO_URI.");
  process.exit(1);
}

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ ONLY ONCE: Admissions routes mounted under /api/admissions
app.use("/api/admissions", admissionsRoutes);

// Static PDFs
// app.use("/files", express.static("storage/pdfs"));

// (Optional) test endpoints you already had...
app.get("/api/test-email", async (_req, res) => {
  try {
    const payload = {
      personal: { name: "Test Student", studentMobile: "9999999999", email: process.env.FROM_EMAIL },
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
  try {
    const buf = Buffer.from("hello awdiz");
    const result = await uploadBuffer({
      buffer: buf,
      folder: "awdiz/test",
      publicId: `ping-${Date.now()}`,
      resource_type: "raw",
      extra: { format: "txt" },
    });
    res.json({ ok: true, url: result.secure_url });
  } catch (e) {
    console.error("Cloudinary test failed:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

(async () => {
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ MongoDB connected");
    app.listen(port, () => console.log(`API on http://localhost:${port}`));
  } catch (e) {
    console.error("❌ Failed to start server:", e.message);
    process.exit(1);
  }
})();
