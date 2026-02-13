// server/src/services/pdf.service.js
import PDFDocument from "pdfkit";
import sharp from "sharp"; // ✅ for webp/other → png/jpeg conversion
import { uploadPDFStream } from "./storage.service.js";


/* ---------------------- image helpers ---------------------- */
// ✅ Accept PNG/JPEG directly; convert WEBP/others → PNG so pdfkit can embed them
const toImageBuffer = async (src) => {
  if (!src) return null;

  const normalizeForPDF = async (buf, contentTypeHint = "") => {
    const ct = (contentTypeHint || "").toLowerCase();
    if (ct.includes("jpeg") || ct.includes("jpg") || ct.includes("png")) return buf;
    try {
      return await sharp(buf).png({ quality: 90 }).toBuffer();
    } catch {
      try { return await sharp(buf).jpeg({ quality: 90 }).toBuffer(); } catch { return null; }
    }
  };

  // Base64 data URL
  if (typeof src === "string" && src.startsWith("data:")) {
    try {
      const [meta, b64] = src.split(",");
      const ct = (meta.match(/^data:(.*?);base64$/i)?.[1] || "").toLowerCase();
      const raw = Buffer.from(b64, "base64");
      return await normalizeForPDF(raw, ct);
    } catch {
      return null;
    }
  }

  // Remote URL (e.g., Cloudinary)
  try {
    const r = await fetch(src);
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const ab = await r.arrayBuffer();
    const raw = Buffer.from(ab);
    if (ct.includes("jpeg") || ct.includes("jpg") || ct.includes("png")) return raw;
    return await normalizeForPDF(raw, ct);
  } catch {
    return null;
  }
};

/** Draw image centered inside a box (maxW x maxH) */
async function drawCenteredImage(doc, buf, x, y, maxW, maxH) {
  if (!buf) return;
  try {
    const meta = await sharp(buf).metadata();
    if (meta?.width && meta?.height) {
      const scale = Math.min(maxW / meta.width, maxH / meta.height);
      const w = meta.width * scale;
      const h = meta.height * scale;
      const cx = x + (maxW - w) / 2;
      const cy = y + (maxH - h) / 2;
      doc.image(buf, cx, cy, { width: w, height: h });
      return;
    }
  } catch {}
  doc.image(buf, x, y, { fit: [maxW, maxH] }); // fallback
}

/* ---------------------- page metrics ----------------------- */
const PAGE_W    = 595.28;              // A4 width (pts)
const MARGIN    = 36;                  // 0.5"
const CONTENT_W = PAGE_W - MARGIN * 2; // inner width

/* ---------------------- tiny utils ------------------------- */
const keep = (v, d = "") => (v === 0 ? "0" : v ? String(v) : d);

function ensureSpace(doc, needed = 50) {
  if (doc.y + needed > doc.page.height - MARGIN) doc.addPage();
}

function heading(doc, text) {
  doc.font("Helvetica-Bold").fontSize(16).text(text, { align: "center" }).moveDown(0.4);
  doc.font("Helvetica");
}

/** Measure a text’s height with given font/size/width (no drawing). */
function heightOf(doc, text, { width, lineGap = 2, font = "Helvetica", size = 10 }) {
  const f0 = doc._font ? doc._font.name : "Helvetica";
  const s0 = doc._fontSize || 10;
  doc.font(font).fontSize(size);
  const h = doc.heightOfString(keep(text, "-"), { width, lineGap });
  doc.font(f0).fontSize(s0);
  return Math.max(h, 12);
}

/** Auto-height, full-width section with title bar. Awaits async content. */
async function sectionBox(doc, titleText, draw) {
  ensureSpace(doc, 45);
  const x = MARGIN, w = CONTENT_W, yTop = doc.y;

  // title stripe
  doc.save()
    .rect(x, yTop, w, 26).fill("#f2f2f2")
    .fillColor("#000").font("Helvetica-Bold").fontSize(13)
    .text(titleText, x + 10, yTop + 6)
    .restore();

  const area = { x, y: yTop + 32, w };
  doc.y = area.y;

  await draw(area);

  const yBottom = doc.y + 6;
  doc.rect(x, yTop, w, yBottom - yTop).stroke();
  doc.y = yBottom + 4; // spacing
}

/** Two-column grid: each row’s height = max(left,right) (no overlap). */
function twoColGrid(doc, area, pairs, opts = {}) {
  const pad = opts.pad ?? 10;
  const gapCols = opts.gapCols ?? 20;

  const labelRatio = opts.labelRatio ?? 0.40;
  const colW = (area.w - pad * 2 - gapCols) / 2;
  const labelW = Math.max(110, Math.floor(colW * labelRatio));
  const valueW = colW - labelW - 4;
  const lineGap = 2;

  let y = doc.y;

  for (let i = 0; i < pairs.length; i += 2) {
    const L = pairs[i] || { label: "", value: "" };
    const R = pairs[i + 1] || null;

    const lH = Math.max(
      heightOf(doc, L.label, { width: labelW, lineGap, font: "Helvetica-Bold", size: 11 }),
      heightOf(doc, keep(L.value, "-"), { width: valueW, lineGap, font: "Helvetica", size: 11 })
    ) + 4;

    let rowH = lH;
    if (R) {
      const rH = Math.max(
        heightOf(doc, R.label, { width: labelW, lineGap, font: "Helvetica-Bold", size: 11 }),
        heightOf(doc, keep(R.value, "-"), { width: valueW, lineGap, font: "Helvetica", size: 11 })
      ) + 4;
      rowH = Math.max(lH, rH);
    }

    ensureSpace(doc, rowH + 4);

    // draw left
    doc.font("Helvetica-Bold").fontSize(11)
       .text(L.label, area.x + pad, y, { width: labelW, lineGap });
    doc.font("Helvetica").fontSize(11)
       .text(keep(L.value, "-"), area.x + pad + labelW + 8, y, { width: valueW, lineGap });

    // draw right
    if (R) {
      const rx = area.x + pad + colW + gapCols;
      doc.font("Helvetica-Bold").fontSize(11)
         .text(R.label, rx, y, { width: labelW, lineGap });
      doc.font("Helvetica").fontSize(11)
         .text(keep(R.value, "-"), rx + labelW + 8, y, { width: valueW, lineGap });
    }

    y += rowH;
  }
  doc.y = y;
}

/** Education table — full width inside section, with header stripe + row lines. */
function drawEduTable(doc, area, rows) {
  const pad = 10;
  const cols = [
    { key: "qualification", title: "Qualification / Exam", w: Math.floor(area.w * 0.30) },
    { key: "school",        title: "School / College",     w: Math.floor(area.w * 0.34) },
    { key: "year",          title: "Year",                 w: Math.floor(area.w * 0.16) },
    { key: "percentage",    title: "% Marks",              w: Math.floor(area.w * 0.16) },
  ];
  const gap = 8;

  const hY = doc.y;
  doc.save().rect(area.x, hY - 2, area.w, 26).fill("#f2f2f2").restore();

  doc.font("Helvetica-Bold").fontSize(11);
  let cx = area.x + pad;
  cols.forEach(c => { doc.text(c.title, cx, hY + 2, { width: c.w }); cx += c.w + gap; });
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(11);
  rows.forEach(r => {
    ensureSpace(doc, 18);
    const y0 = doc.y;
    let cursor = area.x + pad;
    cols.forEach(c => {
      doc.text(keep(r[c.key], "-"), cursor, y0, { width: c.w });
      cursor += c.w + gap;
    });
    const y1 = doc.y;
    doc.save().strokeColor("#e5e5e5").moveTo(area.x, y1).lineTo(area.x + area.w, y1).stroke().restore();
    doc.moveDown(0.4);
  });
}

/** Highlighted notice box */
function noticeBox(doc, text) {
  const x = MARGIN, w = CONTENT_W, h = 40;
  ensureSpace(doc, h + 6);
  const y = doc.y;
  doc.save()
    .rect(x, y, w, h).fill("#FFF9C4")
    .fillColor("#7A5E00").font("Helvetica-Bold").fontSize(11)
    .text(text, x + 12, y + 11, { width: w - 24, align: "center" })
    .restore();
  doc.moveDown(0.5);
}

/* ---------------------- defaults --------------------------- */
const DEFAULT_TRAINING_ONLY_TNC =
  `Fees once paid will not be refunded or adjusted under any circumstances.
By signing this document, you acknowledge that you have received and agreed to learn the syllabus shared by Awdiz.`;

/* ===== Status banner ===== */
function statusBanner(doc, status) {
  if (!status) return;
  const map = {
    approved: { color: "#16a34a", text: "ADMISSION APPROVED" },
    pending:  { color: "#dc2626", text: "ADMISSION PENDING" },
    review:   { color: "#d97706", text: "ADMISSION UNDER REVIEW" },
  };
  const cfg = map[String(status).toLowerCase()] || map.pending;

  const x = MARGIN, w = CONTENT_W, h = 28;
  ensureSpace(doc, h + 4);
  const y = doc.y;

  doc.save()
    .rect(x, y, w, h).fill("#F8FAFC")
    .fillColor(cfg.color).font("Helvetica-Bold").fontSize(12)
    .text(cfg.text, x, y + 7, { width: w, align: "center" })
    .restore();

  doc.moveDown(0.5);
}

/* ===================  T&C helpers (UPDATED)  =================== */
function drawStyledLine(doc, text, opts = {}) {
  const { width = CONTENT_W, align = "left", lineGap = 3 } = opts;

  // Set font first before calculating height
  doc.font("Helvetica").fontSize(11);
  
  // Calculate actual height needed for this text
  const textHeight = doc.heightOfString(text, { width, lineGap });
  const totalHeight = Math.max(textHeight + 8, 24);
  
  ensureSpace(doc, totalHeight);

  if (!text.includes("**") && /[^/]+:\s*\S/.test(text)) {
    const m = text.match(/^([^:]+:)(\s*)(.*)$/);
    if (m) {
      const [, label, sp, rest] = m;
      doc.font("Helvetica-Bold").fontSize(11).text(label, { width, continued: true, align, lineGap });
      doc.font("Helvetica").fontSize(11).text(sp + rest, { width, align, lineGap });
      doc.moveDown(0.2);
      return;
    }
  }

  const parts = text.split(/(\*\*[^*]+?\*\*)/g).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const isBold = p.startsWith("**") && p.endsWith("**");
    const clean = isBold ? p.slice(2, -2) : p;
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(11)
       .text(clean, { width, align, lineGap, continued: i !== parts.length - 1 });
  }
  doc.moveDown(0.2);
}

function drawBullet(doc, raw, level = 0) {
  const text = raw.replace(/^[-•]\s*/, "").trim();
  const bulletX = MARGIN + level * 16;
  const textX   = bulletX + 12;
  const usableW = CONTENT_W - (textX - MARGIN);

  // Set font first before calculating height
  doc.font("Helvetica").fontSize(11);
  
  // Calculate actual height needed for this bullet text
  const textHeight = doc.heightOfString(text, { 
    width: usableW, 
    lineGap: 2
  });
  const totalHeight = Math.max(textHeight + 4, 20);

  ensureSpace(doc, totalHeight);
  const y0 = doc.y;

  doc.font("Helvetica").fontSize(12).text("•", bulletX, y0, { width: 10, continued: false });

  doc.x = textX; doc.y = y0;
  drawStyledLine(doc, text, { width: usableW, align: "left", lineGap: 2 });
  doc.moveDown(0.15);
}

/* ---------- Markdown Table Parsing (kept) ---------- */
function parseMarkdownTable(lines, startIdx) {
  const tableLines = [];
  let i = startIdx;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln || !ln.trim().startsWith("|")) break;
    tableLines.push(ln.trim());
    i++;
  }
  if (tableLines.length < 2) return { next: startIdx, header: [], rows: [] };

  const splitRow = (row) =>
    row
      .replace(/^\|/, "").replace(/\|$/, "")
      .split("|").map(c => c.trim());

  const header = splitRow(tableLines[0]);
  let bodyStart = 1;
  if (/^\|?\s*:?-{3,}/.test(tableLines[1])) bodyStart = 2;

  const rows = tableLines.slice(bodyStart).map(r => splitRow(r));
  return { next: i, header, rows };
}

/* ---------- NEW: Full-page, bordered Course|Details table ---------- */
function drawTCFullTable(doc, header, rows) {
  const x = MARGIN;
  const w = CONTENT_W;
  const pad = 10;

  // ~35% left column (looks like your reference)
  const colW1 = Math.floor(w * 0.35);
  const colW2 = w - colW1;

  const pageBottom = () => doc.page.height - MARGIN;

  // Header band (inside table)
  const drawHeader = () => {
    ensureSpace(doc, 25);
    const hY = doc.y;
    doc.save().rect(x, hY - 2, w, 26).fill("#f2f2f2").restore();
    doc.font("Helvetica-Bold").fontSize(11)
      .text(header[0] || "", x + pad, hY + 2, { width: colW1 - pad })
      .text(header[1] || "", x + pad + colW1, hY + 2, { width: colW2 - pad });
    doc.moveDown(0.5);
    return hY - 2; // return top for outer border
  };

  // open first page
  let tableTopY = drawHeader();

  const writeRow = (course, details) => {
    const y0 = doc.y;

    // Set font before calculating heights
    doc.font("Helvetica").fontSize(11);

    const h = Math.max(
      doc.heightOfString(course,  { width: colW1 - pad, lineGap: 2 }),
      doc.heightOfString(details, { width: colW2 - pad, lineGap: 2 })
    ) + 4;

    // page break BEFORE drawing the row (avoid split)
    // Only add new page if row won't fit at all, otherwise continue on same page
    if (y0 + h + 20 > pageBottom()) {
      // close current page border
      const endY = y0 + 2;
      doc.save().strokeColor("#bfbfbf")
        .rect(x, tableTopY, w, endY - tableTopY).stroke()
        .moveTo(x + colW1, tableTopY).lineTo(x + colW1, endY).stroke()
        .restore();
      doc.addPage();
      tableTopY = drawHeader();
    }

    const y = doc.y;

    // left cell (course) — bold if wrapped with ** **
    const isBold = /^\*\*.*\*\*$/.test(course);
    const cleanCourse = isBold ? course.replace(/^\*\*|\*\*$/g, "") : course;
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(11)
       .text(cleanCourse, x + pad, y, { width: colW1 - pad, lineGap: 2 });

    // right cell (details) — supports **bold** spans
    const parts = String(details).split(/(\*\*[^*]+?\*\*)/g).filter(Boolean);
    doc.x = x + pad + colW1; doc.y = y;
    parts.forEach((p, idx) => {
      const b = p.startsWith("**") && p.endsWith("**");
      const txt = b ? p.slice(2, -2) : p;
      doc.font(b ? "Helvetica-Bold" : "Helvetica").fontSize(11)
         .text(txt, { width: colW2 - pad, lineGap: 2, continued: idx !== parts.length - 1 });
    });

    // row bottom line
    const y1 = Math.max(doc.y, y + h);
    doc.save().strokeColor("#d9d9d9").moveTo(x, y1).lineTo(x + w, y1).stroke().restore();
    doc.y = y1 + 2;
  };

  rows.forEach(r => writeRow(r[0] || "", r[1] || ""));

  // close final border on the last page
  const finalBottom = doc.y + 2;
  doc.save().strokeColor("#bfbfbf")
    .rect(x, tableTopY, w, finalBottom - tableTopY).stroke()
    .moveTo(x + colW1, tableTopY).lineTo(x + colW1, finalBottom).stroke()
    .restore();
}

/** ------- Helpers to force T&C to Only Table when provided ------- */
function buildTableMarkdownFromArray(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  let out = "| Course | Details |\n|---|---|\n";
  rows.forEach(r => {
    const course  = (typeof r === "object" && !Array.isArray(r)) ? (r.course ?? "") : (Array.isArray(r) ? (r[0] ?? "") : "");
    const details = (typeof r === "object" && !Array.isArray(r)) ? (r.details ?? "") : (Array.isArray(r) ? (r[1] ?? "") : "");
    out += `| ${String(course).trim()} | ${String(details).trim()} |\n`;
  });
  return out;
}
function normalizeTableMarkdown(md) {
  if (!md) return "";
  return String(md).trim()
    .replace(/^\s*-{3,}\s*\n?/, "")
    .replace(/\n?\s*-{3,}\s*$/, "")
    .trim();
}

/** Render multi-line T&C with bullets + bold segments + markdown table hook */
function renderTerms(doc, tcText) {
  // Don't trim lines here - we need to detect leading spaces for nested bullets
  const rawLines = (tcText || "").split("\n").map(s => s.replace(/\r/g, ""));

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    
    // Count leading spaces to determine nesting level
    const leadingSpaces = rawLine.match(/^(\s*)/)?.[1]?.length || 0;
    const line = rawLine.trim();
    const nestingLevel = Math.floor(leadingSpaces / 2); // 2 spaces = 1 level

    if (!line) { 
      // Check if we need a page break even for empty lines
      ensureSpace(doc, 8);
      doc.moveDown(0.25); 
      continue; 
    }

    // Heading that precedes a table (kept compatible)
    if (/^#{2,3}\s*\**Eligible Fresher Roles.*\**\s*$/i.test(line)) {
      ensureSpace(doc, 30);
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(14).text(line.replace(/^#+\s*/, "").replace(/\*\*/g, ""), { align: "left" });
      doc.font("Helvetica").fontSize(12).moveDown(0.3);

      const parsed = parseMarkdownTable(rawLines, i + 1);
      if (parsed.rows.length) {
        drawTCFullTable(doc, parsed.header, parsed.rows);  // ✅ full-page bordered table
        i = parsed.next - 1;
        continue;
      }
    }

    // A table that starts immediately
    if (line.startsWith("|")) {
      const parsed = parseMarkdownTable(rawLines, i);
      if (parsed.rows.length) {
        drawTCFullTable(doc, parsed.header, parsed.rows);  // ✅ full-page bordered table
        i = parsed.next - 1;
        continue;
      }
    }

    // bullets (with nesting support) or normal text
    if (/^[-•]\s+/.test(line)) {
      drawBullet(doc, line, nestingLevel);
    } else {
      drawStyledLine(doc, line, { width: CONTENT_W, align: "left", lineGap: 2 });
    }
  }
}
/* ===================  /T&C helpers  =================== */

/* ---------------------- main PDF --------------------------- */
export async function generateAdmissionPDF(payload, opts = {}) {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", c => chunks.push(c));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const tcType = payload?.tc?.type || (payload?.course?.trainingOnly ? "training-only" : "job-guarantee");
  const isTrainingOnly = tcType === "training-only";

  // ✅ force "review" → "pending"
  let status = (opts.status || payload?.status || payload?.statusBanner || "")
    .toString()
    .toLowerCase();
  if (status === "review") status = "pending";

  // Logo (optional)
  if (process.env.AWDIZ_LOGO_URL) {
    const logo = await toImageBuffer(process.env.AWDIZ_LOGO_URL);
    if (logo) { doc.image(logo, MARGIN + CONTENT_W/2 - 50, doc.y, { fit: [100, 60] }); doc.moveDown(3.5); }
  }
  heading(
    doc,
    isTrainingOnly
      ? "AWDIZ Admission Form – Training Program"
      : "AWDIZ Admission Form – Job Guarantee Program"
  );

  if (status) statusBanner(doc, status);

  if (isTrainingOnly) {
    noticeBox(doc, "This admission is for Training-only (No Job Guarantee).");
  }

  const P   = payload.personal || {};
  const C   = payload.course   || {};
  const ID  = payload.ids      || {};
  const CTR = payload.center   || {};

  /* ---------- Personal ---------- */
  await sectionBox(doc, "Personal Information", async (area) => {
    twoColGrid(doc, area, [
      { label: "Mr/Ms", value: `${keep(P.salutation)} ${keep(P.name)}`.trim() },
      { label: "Son/Daughter/Wife of Mr", value: keep(P.fatherOrGuardianName) },

      { label: "Address", value: keep(P.address) },
      { label: "Parent's Mobile", value: keep(P.parentMobile) },

      { label: "Student’s Mobile", value: keep(P.studentMobile) },
      { label: "WhatsApp Mobile", value: keep(P.whatsappMobile) },

      { label: "Email ID", value: keep(P.email) },
      { label: "", value: "" },
    ], { labelRatio: 0.42 });
  });

  /* ---------- Course ---------- */
  await sectionBox(doc, "Course Details", async (area) => {
    const rows = [
      { label: "Admission Type", value: isTrainingOnly ? "Training-only (No Guarantee)" : "Job Guarantee Program" },
      { label: "Course Enrolled", value: keep(C.name) },
      { label: "Reference (Friend/Colleague/Relative)", value: keep(C.reference) },
    ];
    if (isTrainingOnly || C.trainingOnlyCourse) {
      rows.push(
        { label: "Training-only (No Guarantee) Course", value: keep(C.trainingOnlyCourse) },
        { label: "", value: "" }
      );
    }
    twoColGrid(doc, area, rows, { labelRatio: 0.48 });
  });

  /* ---------- Education ---------- */
  await sectionBox(doc, "Educational Details", async (area) => {
    drawEduTable(doc, area, (payload.education || []).map(e => ({
      qualification: keep(e.qualification, "-"),
      school:       keep(e.school, "-"),
      year:         keep(e.year, "-"),
      percentage:   keep(e.percentage, "-"),
    })));
  });

  /* ---------- IDs ---------- */
  await sectionBox(doc, "ID Details", async (area) => {
    twoColGrid(doc, area, [
      { label: "Permanent Account Number (PAN)", value: keep(ID.pan) },
      { label: "Aadhaar Card / Driving License Number", value: keep(ID.aadhaarOrDriving) },
    ], { labelRatio: 0.62 });
  });

  /* ---------- Center + Photo ---------- */
  await sectionBox(doc, "Center", async (area) => {
    const photoW = 150, photoH = 130, gap = 16;
    const leftW  = area.w - photoW - gap;

    twoColGrid(doc, { x: area.x, y: area.y, w: leftW }, [
      { label: "Place of Admission", value: keep(CTR.placeOfAdmission) },
      { label: "Mode", value: keep(CTR.mode) },
    ], { labelRatio: 0.48 });

    const rightX = area.x + leftW + gap;
    const topY   = area.y;

    // ❌ no photo border
    doc.fontSize(9).text("STUDENT PHOTO", rightX, topY - 12, { width: photoW, align: "center" });

    // ✅ prioritize photoDataUrl (passport photo for PDF)
    const photoBuf = await toImageBuffer(payload?.uploads?.photoDataUrl);

    if (photoBuf) {
      await drawCenteredImage(doc, photoBuf, rightX, topY, photoW, photoH);
    }

    doc.y = Math.max(doc.y, topY + photoH);
  });

  /* ---------- T&C (TABLE-ONLY like reference) ---------- */
  doc.addPage();

  // If you pass table via payload.tc.tableMd or payload.tc.table, we render ONLY the table
  const providedTableMd  = normalizeTableMarkdown(payload?.tc?.tableMd || "");
  const providedTableArr = Array.isArray(payload?.tc?.table) && payload.tc.table.length
    ? buildTableMarkdownFromArray(payload.tc.table)
    : "";
  const finalTableMd = normalizeTableMarkdown(providedTableMd || providedTableArr);

  if (finalTableMd) {
    // Just render the table (no heading/notice)
    renderTerms(doc, finalTableMd);
  } else {
    // fallback to old behaviour (kept intact)
    ensureSpace(doc, 30); // Ensure space for heading
    doc.font("Helvetica-Bold").fontSize(14)
      .text(
        isTrainingOnly ? "Training Terms & Conditions" : "Job Guarantee Terms & Conditions",
        { align: "center", underline: true }
      );
    doc.font("Helvetica").moveDown(0.4);
    if (isTrainingOnly) {
      noticeBox(doc, "Training-only enrollment: Fees are non-refundable. Please read the terms carefully.");
    }
    const tcTextRaw = (payload.tc?.text || "").trim();
    const tcText = tcTextRaw || (isTrainingOnly ? DEFAULT_TRAINING_ONLY_TNC : "");
    if (tcText) renderTerms(doc, tcText);
    else doc.text("No Terms & Conditions provided.", { align: "center" });
  }

  /* ---------- Signatures (UNCHANGED) ---------- */
  // Continue on same page as T&C - removed doc.addPage()
  doc.moveDown(0.3);
  doc.fontSize(13)
    .text(`DATE: ${new Date().toLocaleDateString('en-IN')}`)
    .text(`PLACE OF ADMISSION: ${keep(CTR.placeOfAdmission, "-")}`)
    .text(`ONLINE / OFFLINE: ${keep(CTR.mode, "-")}`)
    .moveDown(1.0);

  const sigTop  = doc.y;
  const gapCols = 20;
  const colW    = (CONTENT_W - 2 * gapCols) / 3;
  const colX    = [ MARGIN, MARGIN + colW + gapCols, MARGIN + 2*(colW + gapCols) ];

  // Headings
  doc.font("Helvetica-Bold").fontSize(12)
     .text("STUDENT",              colX[0], sigTop)
     .text("PARENT/GUARDIAN",      colX[1], sigTop)
     .text("For Awdiz Sign & Seal",colX[2], sigTop);
  doc.font("Helvetica");

  const sigY = sigTop + 30;
  const sigH = 130; // bigger slot (as you set earlier)
  const pad  = 4;

  const loadImg = async (...candidates) => {
    for (const c of candidates) {
      const b = await toImageBuffer(c);
      if (b) return b;
    }
    return null;
  };

  // Student signature
  const studentSignBuf = await loadImg(
    payload?.signatures?.student?.signDataUrl,
    payload?.signatures?.student?.signUrl,
    payload?.studentSignatureUrl,
    payload?.files?.studentSignUrl
  );
  if (studentSignBuf) {
    await drawCenteredImage(doc, studentSignBuf, colX[0] + pad, sigY + pad, colW - 10 - pad*2, sigH - pad*2);
  }

  // Parent/Guardian signature — same auto-fallback as before (if you added earlier)

const parentSignBuf = await loadImg(
  payload?.signatures?.parent?.signDataUrl,
  payload?.signatures?.parent?.signUrl,
  payload?.parentSignatureUrl,
  payload?.guardianSignatureUrl,
  payload?.files?.parentSign,
  payload?.files?.guardianSign,
  payload?.files?.parentSignUrl,
  payload?.files?.guardianSignUrl
);

if (parentSignBuf) {
  await drawCenteredImage(
    doc,
    parentSignBuf,
    colX[1] + pad,
    sigY + pad,
    colW - 10 - pad * 2,
    sigH - pad * 2
  );
} else {
  // OPTIONAL debug box so you can SEE the slot + confirm coords
  doc.rect(colX[1] + pad, sigY + pad, colW - 10 - pad * 2, sigH - pad * 2).stroke();
  doc.fontSize(8).text("PARENT SIGN MISSING", colX[1] + pad + 4, sigY + pad + 4);
}

  // Right column: Awdiz sign (top) + seal (bottom)
  const awdizSignBuf = await loadImg(
    payload?.brand?.awdizSignUrl,
    process.env.AWDIZ_SIGN_URL
  );
  const awdizSealBuf = await loadImg(
    payload?.brand?.awdizSealUrl,
    process.env.AWDIZ_SEAL_URL
  );

  const rightInnerX = colX[2] + pad;
  const rightInnerW = colW - 10 - pad*2;
  const rightInnerH = sigH - pad*2;
  const miniGap = 8;
  const slotH = Math.floor((rightInnerH - miniGap) / 2);

  if (awdizSignBuf) {
    await drawCenteredImage(doc, awdizSignBuf, rightInnerX, sigY + pad, rightInnerW, slotH);
  }
  if (awdizSealBuf) {
    await drawCenteredImage(doc, awdizSealBuf, rightInnerX, sigY + pad + slotH + miniGap, rightInnerW, slotH);
  }

  // Names row
  doc.fontSize(11)
     .text(`FULL NAME: ${keep(payload?.signatures?.student?.fullName)}`, colX[0], sigY + sigH + 20)
     .text(`FULL NAME: ${keep(payload?.signatures?.parent?.fullName || payload?.signatures?.guardian?.fullName)}`,  colX[1], sigY + sigH + 20)
     .text(``, colX[2], sigY + sigH + 20);

  doc.moveDown(1.0);
  doc.fontSize(10)
     .text("NOTE: This contract is valid for 12 months from the date of signing. All disputes subject to Mumbai jurisdiction.")
     .text("Addresses: Vashi Plaza (Navi Mumbai) • Bandra (West) Mumbai");

  doc.end();
const pdfBuffer = await done;

/* ✅ UPLOAD PDF TO CLOUDINARY */
const upload = await uploadPDFStream(pdfBuffer, {
  folder: "awdiz/admissions/pdfs",
  publicId: `admission-${Date.now()}`,
});

/* ✅ RETURN CLOUDINARY URL */
return {
  buffer: pdfBuffer,
  url: upload.secure_url,
  public_id: upload.public_id,
};
}
export async function buildAdmissionPdf(payload, opts = {}) {
  const { url } = await generateAdmissionPDF(payload, opts);
  return url;
}
