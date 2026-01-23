
// src/services/storage.service.js
import cloudinary from "../config/cloudinary.js";
import { Readable } from "stream";

const isDummy = process.env.CLOUDINARY_CLOUD_NAME === "dummy";

/**
 * Normalize various binary inputs to a Node.js Readable stream.
 * Supports: Buffer, Node Readable, Web ReadableStream, ArrayBuffer, TypedArray/DataView, string.
 */
function toNodeReadable(input) {
  // Node.js Readable stream
  if (input && typeof input.pipe === "function") return input;

  // Web ReadableStream (Node 18+)
  if (input && typeof input.getReader === "function") return Readable.fromWeb(input);

  // ArrayBuffer
  if (input instanceof ArrayBuffer) return Readable.from(Buffer.from(input));

  // TypedArray / DataView
  if (ArrayBuffer.isView(input)) {
    return Readable.from(
      Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    );
  }

  // Buffer
  if (Buffer.isBuffer(input)) return Readable.from(input);

  // string -> Buffer
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
export function uploadStream({
  source,
  folder,
  publicId,
  resource_type = "auto",
  extra = {},
}) {
  if (isDummy) {
    const ext =
      extra?.format
        ? extra.format
        : resource_type === "raw"
        ? "pdf"
        : "webp";

    const secure_url = `https://dummy.cloudinary.com/${folder}/${publicId || "file"}.${ext}`;
    console.log("🧪 Mock uploadStream:", { folder, publicId, resource_type, ext });

    return Promise.resolve({
      secure_url,
      public_id: publicId || "file",
      resource_type,
      type: "upload",
      access_mode: "public",
    });
  }

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        resource_type,

        // Keep it explicit and consistent
        type: "upload",
        overwrite: true,

        // NOTE:
        // Do NOT force access_mode here unless you have a specific need.
        // For public assets, Cloudinary defaults are usually fine.
        // access_mode: "public",
        // unique_filename: true,

        ...extra,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );

    const readable = toNodeReadable(source);
    readable.pipe(upload);
  });
}

/**
 * Convenience: upload a Buffer as a stream.
 */
export function uploadBuffer({
  buffer,
  folder,
  publicId,
  resource_type = "auto",
  extra = {},
}) {
  return uploadStream({ source: buffer, folder, publicId, resource_type, extra });
}

/**
 * ✅ Convenience: upload a PDF for browser viewing.
 * IMPORTANT:
 * - Uploading PDF as resource_type "image" makes Cloudinary serve it via /image/upload/... which works in your case.
 * - If you keep "raw", your Cloudinary account currently blocks /raw/upload/... with "customer_untrusted".
 */
export function uploadPDFStream(source, { folder, publicId, extra = {} } = {}) {
  return uploadStream({
    source,
    folder,
    publicId,
    resource_type: "image", // ✅ changed from "raw" to "image"
    extra: {
      format: "pdf",
      ...extra,
    },
  });
}

/**
 * Optional: If you ever want to attempt RAW uploads again (download original),
 * you can use this helper. But /raw/upload may stay blocked until Cloudinary removes the restriction.
 */
export function uploadPDFStreamRaw(source, { folder, publicId, extra = {} } = {}) {
  return uploadStream({
    source,
    folder,
    publicId,
    resource_type: "raw",
    extra: {
      format: "pdf",
      ...extra,
    },
  });
}