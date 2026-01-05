

// server/src/lib/googleSheets.js
import { google } from "googleapis";
import path from "path";

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(process.cwd(), "server/src/lib/service-account.json"), // JSON file from Google Cloud
  scopes: ["https://www.googleapis.com/auth/spreadsheets"], // correct scope
});

const sheets = google.sheets({ version: "v4", auth });

// 🔹 Your Google Sheet ID (from URL)
const SPREADSHEET_ID = "1oN4sulZIO1Jkkvl_EAX4JzPrczc__xO1jFcPIGTsNfs";

export async function appendRow(values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A:Z", // must match your sheet/tab name
      valueInputOption: "USER_ENTERED",
      resource: { values: [values] },
    });
    console.log("✅ Row appended successfully!");
  } catch (err) {
    console.error("❌ Error appending row:", err);
    throw err;
  }
}
