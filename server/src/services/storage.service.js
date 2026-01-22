// src/services/storage.service.js
import cloudinary from "../config/cloudinary.js";
import { Readable } from "stream";

const isDummy = process.env.CLOUDINARY_CLOUD_NAME === "dummy";

/**
 * Normalize various binary inputs to a Node.js Readable stream.
 * Supports: Buffer, Node Readable, Web ReadableStream, ArrayBuffer, TypedArray/DataView, string.
 */
function toNodeReadable(input) {
  if (input && typeof input.pipe === "function") return input;           // Node Readable
  if (input && typeof input.getReader === "function") return Readable.fromWeb(input); // Web ReadableStream
  if (input instanceof ArrayBuffer) return Readable.from(Buffer.from(input));
  if (ArrayBuffer.isView(input)) return Readable.from(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  if (Buffer.isBuffer(input)) return Readable.from(input);
  if (typeof input === "string") return Readable.from(Buffer.from(input));
  throw new TypeError("Unsupported input type for upload stream");
}

/**
 * Upload arbitrary binary as a stream to Cloudinary (or mock in dummy mode).
 * @param {Object} opts
 * @param {Buffer|Readable|ReadableStream|ArrayBuffer|TypedArray|string} opts.source
 * @param {string} opts.folder
 * @param {string} [opts.publicId]
 * @param {string} [opts.resource_type="auto"]  // "image" | "raw" | "video" | "auto"
 * @param {Object} [opts.extra]                 // extra Cloudinary options (e.g., format)
 * @returns {Promise<object>} full Cloudinary result
 */
export function uploadStream({ source, folder, publicId, resource_type = "auto", extra = {} }) {
  if (isDummy) {
    const ext =
      extra?.format
        ? extra.format
        : resource_type === "raw"
        ? "pdf"  // default nice extension for raw in our tests; adjust if needed
        : "webp";
    const secure_url = `https://dummy.cloudinary.com/${folder}/${publicId || "file"}.${ext}`;
    console.log("🧪 Mock uploadStream:", { folder, publicId, resource_type, ext });
    return Promise.resolve({ secure_url, public_id: publicId || "file" });
  }

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type, ...extra },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    const readable = toNodeReadable(source);
    readable.pipe(upload);
  });
}

/**
 * Convenience: upload a Buffer as a stream.
 */
export function uploadBuffer({ buffer, folder, publicId, resource_type = "auto", extra = {} }) {
  return uploadStream({ source: buffer, folder, publicId, resource_type, extra });
}

/**
 * Convenience: upload a PDF (buffer/stream/etc) as resource_type 'raw'.
 */
export function uploadPDFStream(source, { folder, publicId, extra = {} } = {}) {
  return uploadStream({ source, folder, publicId, resource_type: "image", extra: { format: "pdf", ...extra } });
}
