// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const { google } = require("googleapis");
const dotenv = require("dotenv");
const session = require("express-session");
// const cors = require("cors");

dotenv.config();

const app = express();
app.use(express.json());

// app.use(cors({ origin: "http://localhost:5173", credentials: true }));

// ==========================================
// SESSION SETUP (store username after login)
// ==========================================
app.use(session({
  secret: "change_this_to_a_long_random_secret",
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: false,
    // sameSite: "lax",
  }
}));

// ==========================================
// GOOGLE SHEETS API SETUP
// ==========================================
const USER_SPREADSHEET_ID = "13_BKNskgFAnwsRATz_XTY-MQ6oytt9nB3IBWxO_Mifg";
const LOG_SPREADSHEET_ID = "1NZNLV7P77DJMFog788hmZmb-D6hUehT-KfWOkwKeM28";
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// ==========================================
// UTILS
// ==========================================
const USER_SHEET_NAME = "USER"; // login lookup
const LOG_SHEET_NAME = "LOGS";  // Username | Company | Page | Timestamp (IST)

function safeTrim(v) {
  return typeof v === "string" ? v.trim() : (v != null ? String(v).trim() : "");
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getSheetData() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: USER_SPREADSHEET_ID,
      range: USER_SHEET_NAME,
    });
    return response.data.values || [];
  } catch (err) {
    console.error("Error reading Google Sheet:", err);
    return null;
  }
}

async function logToSheet({ username, company, page }) {
  const ts = new Date().toLocaleString("en-CA", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).replace(",", "");

  try {
    const resp = await sheets.spreadsheets.values.append({
      spreadsheetId: LOG_SPREADSHEET_ID,
      range: `${LOG_SHEET_NAME}!A:D`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[username || "", company || "", page || "", ts]] },
    });
    if (resp.status !== 200) {
      console.error("Sheets append non-200:", resp.status, resp.statusText);
    }
  } catch (err) {
    console.error("[LOG] Append error:", err?.response?.data || err);
  }
}

// Prefer a company-like field; fall back to TO (for invoices)
function companyFromReplacements(replacements) {
  if (!replacements || typeof replacements !== "object") return "";
  const direct =
    replacements.company ??
    replacements.COMPANY ??
    replacements.companyName ??
    replacements.COMPANY_NAME ??
    replacements.Company ??
    replacements.TO; // CFPL invoice fallback
  if (direct != null) return String(direct);
  for (const [k, v] of Object.entries(replacements)) {
    if (/company/i.test(k)) return String(v ?? "");
  }
  return "";
}

// Indian numbering system words
function numberToIndianWords(num) {
  num = Number(num) || 0;
  if (num === 0) return "Zero Only";
  if (num < 0) return "Negative " + numberToIndianWords(-num);

  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function convertUpToThousand(n) {
    let s = "";
    if (n > 99) {
      s += ones[Math.floor(n / 100)] + " Hundred ";
      n %= 100;
    }
    if (n > 19) {
      s += tens[Math.floor(n / 10)] + " ";
      n %= 10;
    }
    if (n > 0) s += ones[n] + " ";
    return s;
  }

  let result = "";
  let crores = Math.floor(num / 10000000);
  num %= 10000000;
  let lakhs = Math.floor(num / 100000);
  num %= 100000;
  let thousands = Math.floor(num / 1000);
  num %= 1000;

  if (crores) result += convertUpToThousand(crores) + "Crore ";
  if (lakhs) result += convertUpToThousand(lakhs) + "Lakh ";
  if (thousands) result += convertUpToThousand(thousands) + "Thousand ";
  if (num) result += convertUpToThousand(num);

  return result.trim() + " Only";
}

// ==========================================
// LOGIN FUNCTIONALITY (stores username in session)
// ==========================================
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const userData = await getSheetData();
    if (!userData || userData.length === 0) {
      return res.status(500).json({ error: "No user data found in sheet." });
    }

    const rows = userData.slice(1); // skip header
    const matchedRow = rows.find(row => {
      const sheetUsername = safeTrim(row[0]);
      const sheetPassword = safeTrim(row[1]);
      return sheetUsername === safeTrim(username) && sheetPassword === safeTrim(password);
    });

    if (!matchedRow) {
      return res.status(401).json({ success: false, message: "Invalid username or password." });
    }

    req.session.user = { username: safeTrim(username) };

    return res.json({ success: true, message: "Login successful!" });
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).json({ error: "Error fetching user data." });
  }
});

// ==========================================
// SIMPLE AUTH GUARD
// ==========================================
function requireLogin(req, res, next) {
  if (req.session && req.session.user && req.session.user.username) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized. Please log in first." });
}

// ==========================================
// WORD DOCUMENT GENERATION
// ==========================================
app.post("/generate", requireLogin, async (req, res) => {
  try {
    const replacements = req.body && typeof req.body === "object" ? req.body : {};
    let templateFile = "";

    const docType = safeTrim(replacements.page);
    if (!docType) {
      return res.status(400).json({ error: "Missing 'page' in request body." });
    }

    if (docType === "GST Resolution") {
      const directorCount = Array.isArray(replacements.directors) ? replacements.directors.length : 0;
      if (directorCount === 2) templateFile = "GST2.docx";
      else if (directorCount === 3) templateFile = "GST3.docx";
      else if (directorCount === 4) templateFile = "GST4.docx";
      else if (directorCount >= 5) templateFile = "GST5.docx";
      else return res.status(400).json({ error: "GST Resolution requires at least 2 directors." });
    } else if (docType === "Partnership Deed") {
      const partnerCount = Array.isArray(replacements.partners) ? replacements.partners.length : 0;
      if (partnerCount === 2) templateFile = "deed2.docx";
      else if (partnerCount === 3) templateFile = "deed3.docx";
      else if (partnerCount === 4) templateFile = "deed4.docx";
      else if (partnerCount >= 5) templateFile = "deed5.docx";
      else return res.status(400).json({ error: "Partnership Deed requires at least 2 partners." });
    } else if (docType === "LLP Initial") {
      const directorCount = Array.isArray(replacements.directors) ? replacements.directors.length : 0;
      if (directorCount === 2) templateFile = "I2.docx";
      else if (directorCount === 3) templateFile = "I3.docx";
      else if (directorCount === 4) templateFile = "I4.docx";
      else if (directorCount >= 5) templateFile = "I5.docx";
      else return res.status(400).json({ error: "LLP Initial requires at least 2 directors." });
    } else if (docType === "GST Authorization") {
      const directorCount = Array.isArray(replacements.directors) ? replacements.directors.length : 0;
      if (directorCount === 2) templateFile = "GSTA2.docx";
      else if (directorCount === 3) templateFile = "GSTA3.docx";
      else if (directorCount === 4) templateFile = "GSTA4.docx";
      else if (directorCount >= 5) templateFile = "GSTA5.docx";
      else return res.status(400).json({ error: "GST Authorization requires at least 2 directors." });
    } else if (docType === "GST Minutes") {
      const directorCount = Array.isArray(replacements.directors) ? replacements.directors.length : 0;
      if (directorCount === 2) templateFile = "GSTM2.docx";
      else if (directorCount === 3) templateFile = "GSTM3.docx";
      else if (directorCount === 4) templateFile = "GSTM4.docx";
      else if (directorCount >= 5) templateFile = "GSTM5.docx";
      else return res.status(400).json({ error: "GST Minutes requires at least 2 directors." });
    } else if (docType === "CFPL" || docType === "CFPL Invoice") {
      templateFile = "CFPL.docx";
    } else {
      return res.status(400).json({ error: `No valid page type found: ${docType}` });
    }

    const templatePath = path.join(__dirname, "templates", templateFile);
    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({ error: `Template file not found: ${templateFile}` });
    }

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);

    // Precompute invoice totals if CFPL
    let cfplTotals = null;
    if (docType === "CFPL" || docType === "CFPL Invoice") {
      const items = Array.isArray(replacements.invoiceItems) ? replacements.invoiceItems : [];
      let totalGovt = 0;
      let totalProf = 0;
      items.forEach(it => {
        totalGovt += Number(it?.govtFee || 0);
        totalProf += Number(it?.professionalFee || 0);
      });
      const grand = totalGovt + totalProf;
      cfplTotals = {
        totalGovt: totalGovt.toFixed(2),
        totalProf: totalProf.toFixed(2),
        grand: grand.toFixed(2),
        inWords: numberToIndianWords(Math.round(grand)),
      };
    }

    Object.keys(zip.files).forEach((filename) => {
      if (
        /word\/document\.xml$/.test(filename) ||
        /word\/footer[0-9]*\.xml$/.test(filename) ||
        /word\/header[0-9]*\.xml$/.test(filename)
      ) {
        let xml = zip.files[filename].asText();

        // === Replace simple placeholders from "replacements" (excluding arrays) ===
        for (const [key, value] of Object.entries(replacements)) {
          if (key === "directors" || key === "partners" || key === "invoiceItems") continue;
          const regex = new RegExp(`{{${escapeRegExp(key)}}}`, "g");
          xml = xml.replace(regex, value != null ? String(value) : "");
        }

        // ===== Arrays handling =====

        // GST Resolution
        if (docType === "GST Resolution" && Array.isArray(replacements.directors)) {
          replacements.directors.forEach((director, index) => {
            const idx = index + 1;
            [
              [`PERSON_${idx}`, director?.name],
              [`PERSON_${idx}_D`, director?.designation],
              [`PERSON_${idx}_DIN`, director?.din],
            ].forEach(([ph, val]) => {
              xml = xml.replace(new RegExp(`{{${escapeRegExp(ph)}}}`, "g"), val != null ? String(val) : "");
            });
          });
        }

        // Partnership Deed
        if (docType === "Partnership Deed" && Array.isArray(replacements.partners)) {
          replacements.partners.forEach((partner, index) => {
            const idx = index + 1;
            [
              [`PERSON_${idx}`, partner?.name],
              [`FATHER_${idx}`, partner?.father],
              [`PAN_${idx}`, partner?.pan],
              [`ADDRESS_${idx}`, partner?.address],
              [`SHARE-Rs_${idx}`, partner?.shareRs],
              [`SHARE-%_${idx}`, partner?.sharePercent],
            ].forEach(([ph, val]) => {
              xml = xml.replace(new RegExp(`{{${escapeRegExp(ph)}}}`, "g"), val != null ? String(val) : "");
            });
          });
        }

        // LLP Initial
        if (docType === "LLP Initial" && Array.isArray(replacements.directors)) {
          replacements.directors.forEach((director, index) => {
            const idx = index + 1;
            [
              [`PERSON_${idx}`, director?.name],
              [`FATHER_${idx}`, director?.father],
              [`PERSON_${idx}_D`, director?.designation],
              [`PERSON_${idx}_DIN`, director?.din],
              [`PAN_${idx}`, director?.pan],
              [`ADDRESS_${idx}`, director?.address],
              [`SHARE-Rs_${idx}`, director?.shareRs],
              [`SHARE-%_${idx}`, director?.sharePercent],
            ].forEach(([ph, val]) => {
              xml = xml.replace(new RegExp(`{{${escapeRegExp(ph)}}}`, "g"), val != null ? String(val) : "");
            });
          });
        }

        // GST Authorization
        if (docType === "GST Authorization" && Array.isArray(replacements.directors)) {
          replacements.directors.forEach((director, index) => {
            const idx = index + 1;
            [
              [`PERSON_${idx}`, director?.name],
              [`PERSON_${idx}_D`, director?.designation],
              [`PERSON_${idx}_DIN`, director?.din],
            ].forEach(([ph, val]) => {
              xml = xml.replace(new RegExp(`{{${escapeRegExp(ph)}}}`, "g"), val != null ? String(val) : "");
            });
          });
        }

        // GST Minutes
        if (docType === "GST Minutes" && Array.isArray(replacements.directors)) {
          replacements.directors.forEach((director, index) => {
            const idx = index + 1;
            [
              [`PERSON_${idx}`, director?.name],
              [`PERSON_${idx}_D`, director?.designation],
              [`PERSON_${idx}_DIN`, director?.din],
              [`EQUITY_SHARES_${idx}`, director?.equityShares],
              [`FOLIO_${idx}`, director?.folioNo],
              [`CERTI_NO_${idx}`, director?.certNo],
              [`FROM_${idx}`, director?.From],
              [`TO_${idx}`, director?.To],
            ].forEach(([ph, val]) => {
              xml = xml.replace(new RegExp(`{{${escapeRegExp(ph)}}}`, "g"), val != null ? String(val) : "");
            });
          });
        }

        // ===== CFPL Invoice (line items + totals) =====
        if ((docType === "CFPL" || docType === "CFPL Invoice")) {
          const items = Array.isArray(replacements.invoiceItems) ? replacements.invoiceItems : [];
          const MAX_ROWS = 25;

          for (let i = 1; i <= MAX_ROWS; i++) {
            const item = items[i - 1] || {};
            const desc = item.description != null ? String(item.description) : "";
            const govt = item.govtFee != null ? Number(item.govtFee).toFixed(2) : "";
            const prof = item.professionalFee != null ? Number(item.professionalFee).toFixed(2) : "";

            xml = xml.replace(new RegExp(`{{${escapeRegExp(`D${i}`)}}}`, "g"), desc);
            xml = xml.replace(new RegExp(`{{${escapeRegExp(`G${i}`)}}}`, "g"), desc ? govt : "");
            xml = xml.replace(new RegExp(`{{${escapeRegExp(`P${i}`)}}}`, "g"), desc ? prof : "");
          }

          if (cfplTotals) {
            xml = xml.replace(/{{TOTAL_GOVT}}/g, cfplTotals.totalGovt);
            xml = xml.replace(/{{TOTAL_PROFESSIONAL}}/g, cfplTotals.totalProf);
            xml = xml.replace(/{{GRAND_TOTAL}}/g, cfplTotals.grand);
            xml = xml.replace(/{{GRAND_TOTAL_WORDS}}/g, cfplTotals.inWords);
          }
        }

        // Save XML back
        zip.file(filename, xml);
      }
    });

    // Generate docx
    const buf = zip.generate({ type: "nodebuffer" });

    // Log with session username and TO/company
    const { username } = req.session.user || {};
    const company = companyFromReplacements(replacements);
    await logToSheet({ username: username || "", company, page: docType || "UNKNOWN_PAGE" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.send(buf);

  } catch (err) {
    console.error("❌ Error generating Word document:", err);
    res.status(500).json({ error: "Error generating Word document" });
  }
});

// ✅ Serve frontend last
app.use(express.static(path.join(__dirname, "public")));

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
