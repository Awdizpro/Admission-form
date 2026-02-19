
// server/src/services/sheets.service.js

import { google } from "googleapis";

/* ============================ ENV / AUTH ============================ */
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// Center-wise sheet IDs
const SHEET_ID_VASHI = process.env.SHEET_ID_VASHI || "";
const SHEET_ID_BANDRA = process.env.SHEET_ID_BANDRA || "";

// ✅ Master Sheet ID (AWDIZ Master Sheet)
const SHEET_ID_AWDIZ_MASTER_SHEET = process.env.SHEET_ID_AWDIZ_MASTER_SHEET || "";

// ✅ Counselor-wise separate spreadsheets (privacy separation)
const SHEET_ID_COUNSELOR_1 = process.env.SHEET_COUNSELOR_1_ID || "";
const SHEET_ID_COUNSELOR_2 = process.env.SHEET_COUNSELOR_2_ID || "";

/**
 * ✅ FIX (DON'T REMOVE COMMENTS ABOVE):
 * Tumne env constants comment kiye hai but code unko use karta hai.
 * Isliye runtime error aa raha tha.
 * Ab safe defaults + env support enable kiya hai.
 */
const MASTER_TAB_COUNSELOR_1 =
  process.env.MASTER_TAB_COUNSELOR_1 || "Counselor 1 Sheet";
const MASTER_TAB_COUNSELOR_2 =
  process.env.MASTER_TAB_COUNSELOR_2 || "Counselor 2 Sheet";
const MASTER_TAB_ALL_ADMISSIONS =
  process.env.MASTER_TAB_ALL_ADMISSIONS || "All Admissions";

// ✅ NEW: Counselor spreadsheets me bhi ek All Admissions tab
const COUNSELOR_TAB_ALL_ADMISSIONS =
  process.env.COUNSELOR_TAB_ALL_ADMISSIONS || "All Admissions";

// Optional global fallback
const SPREADSHEET_ID_FALLBACK = process.env.GOOGLE_SPREADSHEET_ID || "";

/* ============================ SHEETS CLIENT ========================= */
export async function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: CLIENT_EMAIL,
    key: PRIVATE_KEY,
    scopes: SCOPES,
  });
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

/* ============================= ROUTING ============================== */
export function spreadsheetIdForCenter(centerPlace) {
  const c = String(centerPlace || "").trim().toLowerCase();
  if (c === "vashi") return SHEET_ID_VASHI || SPREADSHEET_ID_FALLBACK;
  if (c === "bandra") return SHEET_ID_BANDRA || SPREADSHEET_ID_FALLBACK;
  return SPREADSHEET_ID_FALLBACK;
}

// ✅ Master Sheet tab name by center
function masterTabNameForCenter(centerPlace) {
  const c = String(centerPlace || "").trim().toLowerCase();
  if (c === "vashi") return "Master Sheet Vashi";
  if (c === "bandra") return "Master Sheet Bandra";
  return "Master Sheet General";
}

// ✅ counselorKey resolver (c1 / c2)
function counselorKeyFromData(data) {
  const k =
    data?.counselorKey ||
    data?.meta?.counselorKey ||
    data?.payload?.counselorKey ||
    data?.payload?.meta?.counselorKey ||
    "";

  const key = String(k || "").trim().toLowerCase();
  if (key === "c2" || key === "counselor2" || key === "2") return "c2";
  return "c1"; // default
}

// ✅ map counselorKey -> spreadsheetId + master tab name
function counselorSpreadsheetIdForKey(key) {
  if (key === "c2") return SHEET_ID_COUNSELOR_2;
  return SHEET_ID_COUNSELOR_1;
}
function counselorMasterTabForKey(key) {
  if (key === "c2") return MASTER_TAB_COUNSELOR_2;
  return MASTER_TAB_COUNSELOR_1;
}

/* ============================ UTILITIES ============================= */
function colIndexToLetter(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * ✅ IMPORTANT FIX:
 * Google Sheets A1 notation me tab name me spaces/() etc ho to wrap + escape zaroori hai.
 * Aur agar sheetName accidentally "'Data Science'" jaisa aa gaya (already quoted),
 * to normalize karke clean title nikalo.
 */
function normalizeSheetTitle(name) {
  let s = String(name || "").trim();
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  return s.trim();
}
function a1SheetName(name) {
  const t = normalizeSheetTitle(name).replace(/'/g, "''");
  return `'${t}'`;
}

// Create tab if missing (uses CLEAN title, not A1 quoted)
async function ensureSheetExistsInternal(sheets, spreadsheetId, sheetName) {
  const title = normalizeSheetTitle(sheetName);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties?.title === title
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
  }
}

// Find gid by title (uses CLEAN title)
async function getSheetIdByTitle(sheets, spreadsheetId, title) {
  const t = normalizeSheetTitle(title);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sh = (meta.data.sheets || []).find((s) => s.properties?.title === t);
  return sh?.properties?.sheetId;
}

/* ====================== LAYOUT / FORMATTING ========================= */
async function autoResizeAllColumns(sheets, spreadsheetId, sheetId, headersLen) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: headersLen,
            },
          },
        },
      ],
    },
  });
}

async function applyNeatLayout(sheets, spreadsheetId, sheetId, headersLen) {
  const requests = [];

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  });

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: headersLen,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.96, green: 0.96, blue: 0.96 },
          textFormat: { bold: true },
          horizontalAlignment: "LEFT",
          verticalAlignment: "MIDDLE",
          wrapStrategy: "CLIP",
        },
      },
      fields:
        "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
    },
  });

  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 32 },
      fields: "pixelSize",
    },
  });

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: headersLen,
      },
      cell: {
        userEnteredFormat: {
          wrapStrategy: "CLIP",
          verticalAlignment: "TOP",
        },
      },
      fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
    },
  });

  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 5000 },
      properties: { pixelSize: 24 },
      fields: "pixelSize",
    },
  });

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: 1,
      },
      cell: {
        userEnteredFormat: {
          numberFormat: {
            type: "DATE_TIME",
            pattern: "dd-mm-yyyy hh:mm AM/PM",
          },
        },
      },
      fields: "userEnteredFormat.numberFormat",
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

async function ensureHeaderIfMissing(sheets, spreadsheetId, sheetName, headers) {
  const title = normalizeSheetTitle(sheetName);
  const colEnd = colIndexToLetter(headers.length);
  const range = `${a1SheetName(title)}!A1:${colEnd}1`;

  const get = await sheets.spreadsheets.values
    .get({ spreadsheetId, range })
    .catch(() => null);

  const hasHeader = get?.data?.values?.[0]?.length;

  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });

    const sheetId = await getSheetIdByTitle(sheets, spreadsheetId, title);
    if (sheetId != null) {
      await applyNeatLayout(sheets, spreadsheetId, sheetId, headers.length);
      await autoResizeAllColumns(sheets, spreadsheetId, sheetId, headers.length);
    }
  }
}

/* ================== STATUS CONDITIONAL FORMATTING =================== */
async function ensureStatusConditionalFormatting(
  sheets,
  spreadsheetId,
  sheetName
) {
  const title = normalizeSheetTitle(sheetName);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });

  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties?.title === title
  );
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId == null) return;

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1SheetName(title)}!A1:ZZ1`,
  });

  const header = data.values?.[0] || [];
  const colStatus = header.indexOf("Status");
  if (colStatus === -1) return;

  const statusRange = {
    sheetId,
    startRowIndex: 1,
    startColumnIndex: colStatus,
    endColumnIndex: colStatus + 1,
  };

  for (let i = 0; i < 5; i++) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ deleteConditionalFormatRule: { sheetId, index: i } }],
        },
      });
    } catch {}
  }

  const requests = [
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [statusRange],
          booleanRule: {
            condition: {
              type: "TEXT_EQ",
              values: [{ userEnteredValue: "Approved" }],
            },
            format: {
              backgroundColor: { red: 0.86, green: 0.95, blue: 0.87 },
              textFormat: { bold: true },
            },
          },
        },
        index: 0,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [statusRange],
          booleanRule: {
            condition: {
              type: "TEXT_EQ",
              values: [{ userEnteredValue: "Pending" }],
            },
            format: {
              backgroundColor: { red: 0.98, green: 0.88, blue: 0.88 },
              textFormat: { bold: true },
            },
          },
        },
        index: 0,
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

/* ========================== MAPPING HELPERS ========================= */
function getEdu(edus, index) {
  const e = Array.isArray(edus) ? edus[index] : null;
  return {
    qualification: e?.qualification || "",
    school: e?.school || "",
    year: e?.year || "",
    percentage: e?.percentage || "",
  };
}

function prepareRowValues(data, courseName) {
  const e10 = getEdu(data?.education, 0);
  const e12 = getEdu(data?.education, 1);
  const edp = getEdu(data?.education, 2);
  const egr = getEdu(data?.education, 3);

  const photoUrl =
    data?.photoUrl ||
    data?.files?.photoUrl ||
    data?.uploads?.photoUrl ||
    data?.images?.photoUrl ||
    "";

  const panNumber = data?.ids?.pan || "";
  const panFileUrl = data?.uploads?.panUrl || "";
  const aadNum = data?.ids?.aadhaarOrDriving || "";
  const aadFileUrl = data?.uploads?.aadhaarUrl || "";

  const nowIST = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });

  const planType = data?.meta?.planType === "training" ? "training" : "job";
  const tcType =
    data?.tc?.type ||
    (planType === "training" ? "training-only" : "job-guarantee");

  // const admissionId = data?.admissionId || "";
  const admissionId =
  data?.admissionId ||
  data?._id?.toString?.() ||                                      //New Added=============
  data?.id ||
  "";

  const status = data?.status || "Pending";
  const approvedAt = data?.approvedAt || "";
  const approvedPdf = data?.approvedPdfUrl || "";
  const feeAmount =
    data?.fees?.amount ||
    data?.meta?.feeAmount ||
    data?.feeAmount ||
    "";
    const feeMode =
  data?.fees?.paymentMode ||   // ✅ FIX
  data?.meta?.feeMode ||
  data?.feeMode ||
  "";

  const counselorKey = counselorKeyFromData(data);

  return [
    nowIST,
    status,
    data?.center?.placeOfAdmission || "",
    counselorKey,
    data?.personal?.name || "",
    data?.personal?.fatherOrGuardianName || "",
    data?.personal?.address || "",
    data?.personal?.parentMobile || "",
    data?.personal?.studentMobile || "",
    data?.personal?.whatsappMobile || "",
    data?.personal?.email || "",
    courseName || data?.course?.name || "",
    data?.course?.reference || "",
    e10.qualification,
    e10.school,
    e10.year,
    e10.percentage,
    e12.qualification,
    e12.school,
    e12.year,
    e12.percentage,
    edp.qualification,
    edp.school,
    edp.year,
    edp.percentage,
    egr.qualification,
    egr.school,
    egr.year,
    egr.percentage,
    photoUrl,
    panNumber,
    panFileUrl,
    aadNum,
    aadFileUrl,
    data?.center?.mode || "",
    data?.signatures?.student?.fullName || "",
    data?.signatures?.parent?.fullName || "",
    planType,
    tcType,
    data?.tc?.accepted ? "Yes" : "No",
    data?.pdfUrl || "",
    admissionId,
    approvedAt,
    approvedPdf,
     // ✅ NEW
    feeAmount,
    feeMode,
    // ✅ NEW - Extended fee details for counselor review
    data?.fees?.totalFees || "",
    data?.fees?.pendingFees || "",
    data?.fees?.instalmentDates?.[0] ? new Date(data.fees.instalmentDates[0]).toLocaleDateString("en-IN") : "",
    data?.fees?.instalmentAmounts?.[0] || "",
    data?.fees?.instalmentDates?.[1] ? new Date(data.fees.instalmentDates[1]).toLocaleDateString("en-IN") : "",
    data?.fees?.instalmentAmounts?.[1] || "",
    data?.fees?.instalmentDates?.[2] ? new Date(data.fees.instalmentDates[2]).toLocaleDateString("en-IN") : "",
    data?.fees?.instalmentAmounts?.[2] || "",
    data?.fees?.isBajajEMI ? "Yes" : "No",
    data?.fees?.isCheck ? "Yes" : "No",
    data?.fees?.additionalFees || "",
    data?.fees?.additionalFeeMode || "",
  ];
}

/* =================== APPEND (NEWEST FIRST) =========================== */
async function appendToSheet(sheets, spreadsheetId, sheetName, courseName, data) {
  if (!spreadsheetId) return;

  const title = normalizeSheetTitle(sheetName);
  await ensureSheetExistsInternal(sheets, spreadsheetId, title);

  const HEADERS = [
    "Timestamp (IST)",
    "Status",
    "Center",
    "CounselorKey",
    "Full Name",
    "Father/Guardian",
    "Address",
    "Parent Mobile",
    "Student Mobile",
    "WhatsApp Mobile",
    "Email",
    "Course",
    "Reference",
    "10th - Qualification",
    "10th - School/College",
    "10th - Year",
    "10th - Marks/Grade",
    "12th - Qualification",
    "12th - School/College",
    "12th - Year",
    "12th - Marks/Grade",
    "Diploma - Qualification",
    "Diploma - Institute",
    "Diploma - Year",
    "Diploma - Marks/Grade",
    "Graduation - Qualification",
    "Graduation - College/University",
    "Graduation - Year",
    "Graduation - Marks/Grade",
    "Photo URL",
    "PAN Number",
    "PAN File URL",
    "Aadhaar/Driving Number",
    "Aadhaar/Driving File URL",
    "Mode",
    "Student Signature Name",
    "Parent/Guardian Signature Name",
    "Plan Type",
    "T&C Type",
    "T&C Accepted",
    "PDF URL",
    "AdmissionID",
    "ApprovedAt",
    "Approved PDF URL",
    // ✅ NEW
    "Fees Amount",
    "Payment Mode",
    // ✅ NEW - Extended fee details for counselor review
    "Total Fees",
    "Pending Fees",
    "Instalment 1 Date",
    "Instalment 1 Amount",
    "Instalment 2 Date",
    "Instalment 2 Amount",
    "Instalment 3 Date",
    "Instalment 3 Amount",
    "Bajaj EMI Process",
    "Cheque Payment",
    "Split Fees",
    "Split Fees Mode",
  ];

  await ensureHeaderIfMissing(sheets, spreadsheetId, title, HEADERS);

  const { data: existingData } = await sheets.spreadsheets.values
    .get({
      spreadsheetId,
      range: `${a1SheetName(title)}!A2:ZZ`,
    })
    .catch(() => ({ data: { values: [] } }));

  const existingRows = existingData.values || [];
  const newRow = prepareRowValues(data, courseName);
  const allRows = [newRow, ...existingRows];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${a1SheetName(title)}!A2:${colIndexToLetter(HEADERS.length)}${
      allRows.length + 1
    }`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: allRows },
  });

  const sheetId = await getSheetIdByTitle(sheets, spreadsheetId, title);
  if (sheetId != null) {
    await applyNeatLayout(sheets, spreadsheetId, sheetId, HEADERS.length);
    await autoResizeAllColumns(sheets, spreadsheetId, sheetId, HEADERS.length);
    await ensureStatusConditionalFormatting(sheets, spreadsheetId, title);
  }
}

/* ============================== PUBLIC ============================== */
export async function appendAdmissionRow(courseName, data) {
  const sheets = await getSheetsClient();

  const centerPlace = data?.center?.placeOfAdmission || "";
  const centerSpreadsheetId = spreadsheetIdForCenter(centerPlace);
  const masterSpreadsheetId = SHEET_ID_AWDIZ_MASTER_SHEET;

  if (!centerSpreadsheetId) {
    throw new Error(
      "No spreadsheet ID configured. Set SHEET_ID_VASHI / SHEET_ID_BANDRA or GOOGLE_SPREADSHEET_ID."
    );
  }
  if (!masterSpreadsheetId) {
    throw new Error(
      "No master spreadsheet ID configured. Set SHEET_ID_AWDIZ_MASTER_SHEET."
    );
  }

  const sheetTabName = (courseName && String(courseName).trim()) || "General";

  // 1) Center Spreadsheet
  await appendToSheet(sheets, centerSpreadsheetId, sheetTabName, courseName, data);

  // 2) Master Spreadsheet → Center Master tab
  const masterTabName = masterTabNameForCenter(centerPlace);
  await appendToSheet(sheets, masterSpreadsheetId, masterTabName, courseName, data);

  // 3/4/5) Counselor routing
  const counselorKey = counselorKeyFromData(data);
  const counselorSpreadsheetId = counselorSpreadsheetIdForKey(counselorKey);
  const masterCounselorTab = counselorMasterTabForKey(counselorKey);

  if (counselorSpreadsheetId) {
    // ✅ counselor sheet: course tab
    await appendToSheet(sheets, counselorSpreadsheetId, sheetTabName, courseName, data);

    // ✅ counselor sheet: All Admissions tab
    await appendToSheet(
      sheets,
      counselorSpreadsheetId,
      COUNSELOR_TAB_ALL_ADMISSIONS,
      courseName,
      data
    );
  }

  await appendToSheet(sheets, masterSpreadsheetId, masterCounselorTab, courseName, data);
  await appendToSheet(
    sheets,
    masterSpreadsheetId,
    MASTER_TAB_ALL_ADMISSIONS,
    courseName,
    data
  );
}

/* ====================== STATUS UPDATE HELPERS ======================= */
async function findRowByAdmissionIdInternal(
  sheets,
  spreadsheetId,
  sheetName,
  admissionId
) {
  if (!spreadsheetId) return null;

  const title = normalizeSheetTitle(sheetName);
  const range = `${a1SheetName(title)}!A:ZZ`;

  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = data.values || [];
  if (rows.length === 0) return null;

  const header = rows[0] || [];
  const colAdmissionId = header.indexOf("AdmissionID");
  if (colAdmissionId === -1) return null;

  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][colAdmissionId] || "") === admissionId) {
      return { row: i + 1, header, rows };
    }
  }
  return null;
}

async function updateStatusInSheet(
  sheets,
  spreadsheetId,
  sheetName,
  admissionId,
  status,
  extra = {}
) {
  if (!spreadsheetId) return false;

  const title = normalizeSheetTitle(sheetName);

  const hit = await findRowByAdmissionIdInternal(
    sheets,
    spreadsheetId,
    title,
    admissionId
  );

  if (!hit) {
    console.log("❌ updateStatusInSheet: row not found", {
      spreadsheetId,
      tab: title,
      admissionId,
    });
    return false;
  }

  const { header, row } = hit;
  const colStatus = header.indexOf("Status");
  const colApprovedAt = header.indexOf("ApprovedAt");
  const colApprovedPdf = header.indexOf("Approved PDF URL");

  if (colStatus === -1 || colApprovedAt === -1 || colApprovedPdf === -1)
    return false;

  const toCol = (idx) => colIndexToLetter(idx + 1);
  const startCol = Math.min(colStatus, colApprovedAt, colApprovedPdf);
  const endCol = Math.max(colStatus, colApprovedAt, colApprovedPdf);

  const isApproved = String(status || "").toLowerCase() === "approved";

  const rowVals = [];
  for (let i = startCol; i <= endCol; i++) {
    if (i === colStatus) {
      rowVals.push(isApproved ? "Approved" : "Pending");
    } else if (i === colApprovedAt) {
      rowVals.push(
        isApproved
          ? new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
          : ""
      );
    } else if (i === colApprovedPdf) {
      rowVals.push(isApproved ? extra?.approvedPdfUrl || "" : "");
    } else {
      rowVals.push(null);
    }
  }

  const range = `${a1SheetName(title)}!${toCol(startCol)}${row}:${toCol(
    endCol
  )}${row}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [rowVals] },
  });

  await ensureStatusConditionalFormatting(sheets, spreadsheetId, title);
  return true;
}

export async function setAdmissionStatus(
  centerPlace,
  sheetName,
  admissionId,
  status,
  extra = {}
) {
  const sheets = await getSheetsClient();

  const centerSpreadsheetId = spreadsheetIdForCenter(centerPlace);
  const masterSpreadsheetId = SHEET_ID_AWDIZ_MASTER_SHEET;

  if (!centerSpreadsheetId || !masterSpreadsheetId) return false;

  const tabTitle = normalizeSheetTitle(sheetName);

  const centerUpdated = await updateStatusInSheet(
    sheets,
    centerSpreadsheetId,
    tabTitle,
    admissionId,
    status,
    extra
  );

  const masterTabName = masterTabNameForCenter(centerPlace);
  const masterUpdated = await updateStatusInSheet(
    sheets,
    masterSpreadsheetId,
    masterTabName,
    admissionId,
    status,
    extra
  );

  const counselorKey = counselorKeyFromData(extra) || "c1";
  const counselorSpreadsheetId = counselorSpreadsheetIdForKey(counselorKey);
  const masterCounselorTab = counselorMasterTabForKey(counselorKey);

  // ✅ counselor updates (course tab + counselor all admissions tab)
  let counselorUpdated = true;
  if (counselorSpreadsheetId) {
    const u1 = await updateStatusInSheet(
      sheets,
      counselorSpreadsheetId,
      tabTitle,
      admissionId,
      status,
      extra
    );

    const u2 = await updateStatusInSheet(
      sheets,
      counselorSpreadsheetId,
      COUNSELOR_TAB_ALL_ADMISSIONS,
      admissionId,
      status,
      extra
    );

    counselorUpdated = u1 && u2;
  }

  const masterCounselorUpdated = await updateStatusInSheet(
    sheets,
    masterSpreadsheetId,
    masterCounselorTab,
    admissionId,
    status,
    extra
  );

  const masterAllUpdated = await updateStatusInSheet(
    sheets,
    masterSpreadsheetId,
    MASTER_TAB_ALL_ADMISSIONS,
    admissionId,
    status,
    extra
  );

  return (
    centerUpdated &&
    masterUpdated &&
    counselorUpdated &&
    masterCounselorUpdated &&
    masterAllUpdated
  );
}

/* ===================== UPDATE ROW ON EDIT ====================== */
export async function updateAdmissionRow(courseName, data) {
  const sheets = await getSheetsClient();

  const centerPlace = data?.center?.placeOfAdmission || "";
  const spreadsheetId = spreadsheetIdForCenter(centerPlace);
  const masterSpreadsheetId = SHEET_ID_AWDIZ_MASTER_SHEET;

  if (!spreadsheetId || !masterSpreadsheetId) {
    throw new Error("Spreadsheet ID missing");
  }

  const courseTab = normalizeSheetTitle(
    (courseName && String(courseName).trim()) || "Admissions"
  );

  const masterTab = masterTabNameForCenter(centerPlace);

  await updateRowInternal(sheets, spreadsheetId, courseTab, courseName, data);
  await updateRowInternal(sheets, masterSpreadsheetId, masterTab, courseName, data);

  const counselorKey = counselorKeyFromData(data);
  const counselorSpreadsheetId = counselorSpreadsheetIdForKey(counselorKey);
  const masterCounselorTab = counselorMasterTabForKey(counselorKey);

  if (counselorSpreadsheetId) {
    // ✅ counselor sheet: course tab
    await updateRowInternal(sheets, counselorSpreadsheetId, courseTab, courseName, data);

    // ✅ counselor sheet: All Admissions tab
    await updateRowInternal(
      sheets,
      counselorSpreadsheetId,
      COUNSELOR_TAB_ALL_ADMISSIONS,
      courseName,
      data
    );
  }

  await updateRowInternal(sheets, masterSpreadsheetId, masterCounselorTab, courseName, data);
  await updateRowInternal(
    sheets,
    masterSpreadsheetId,
    MASTER_TAB_ALL_ADMISSIONS,
    courseName,
    data
  );
}

async function updateRowInternal(sheets, spreadsheetId, sheetName, courseName, data) {
  if (!spreadsheetId) return;

  const title = normalizeSheetTitle(sheetName);

  const hit = await findRowByAdmissionIdInternal(
    sheets,
    spreadsheetId,
    title,
    // data.admissionId
    (data?.admissionId || data?._id?.toString?.() || "")

  );

  if (!hit) {
    console.log("❌ No existing row found:", data.admissionId, {
      spreadsheetId,
      tab: title,
    });
    return;
  }

  const { row } = hit;
  const newRow = prepareRowValues(data, courseName);

  const range = `${a1SheetName(title)}!A${row}:${colIndexToLetter(newRow.length)}${row}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [newRow] },
  });

  console.log(`✅ Row #${row} updated successfully in "${title}"`);
}
