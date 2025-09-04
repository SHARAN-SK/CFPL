// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const { google } = require("googleapis");
const dotenv = require("dotenv");
const session = require("express-session");
const { JSDOM } = require("jsdom"); // Use JSDOM to access the numberToIndianWords function from the frontend HTML

// If your frontend runs on a different origin, enable CORS with credentials:
// const cors = require("cors");

dotenv.config();

const app = express();
app.use(express.json());

// === If your frontend is on a different origin, enable CORS ===
// app.use(cors({
//   origin: "http://localhost:5173", // <--- change to your frontend origin
//   credentials: true
// }));

// ==========================================
// SESSION SETUP (store username after login)
// ==========================================
app.use(session({
    secret: "change_this_to_a_long_random_secret",
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false, // set true with HTTPS
        // sameSite: "lax", // for cross-site over HTTPS use: sameSite: "none", secure: true
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
    // WRITE access needed for logging
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({
    version: "v4",
    auth,
});

// ==========================================
// UTILS
// ==========================================
const USER_SHEET_NAME = "USER"; // login lookup
const LOG_SHEET_NAME = "LOGS";  // Columns: Username | Company | Page | Timestamp (IST)

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
    // IST timestamp
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
            requestBody: {
                values: [[username || "", company || "", page || "", ts]],
            },
        });
        if (resp.status !== 200) {
            console.error("Sheets append non-200:", resp.status, resp.statusText);
        }
    } catch (err) {
        console.error("[LOG] Append error:", err?.response?.data || err);
        // Do not throw; logging failure shouldn't block file download
    }
}

// Pull company from replacements (case-insensitive, flexible keys)
function companyFromReplacements(replacements) {
    if (!replacements || typeof replacements !== "object") return "";
    // Prefer common keys
    const direct =
        replacements.company ??
        replacements.COMPANY ??
        replacements.companyName ??
        replacements.COMPANY_NAME ??
        replacements.Company ??
        replacements.TO; // Added TO for the invoice page
    if (direct != null) return String(direct);

    // Fallback: first key containing "company" (case-insensitive)
    for (const [k, v] of Object.entries(replacements)) {
        if (/company/i.test(k)) return String(v ?? "");
    }
    return "";
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

        // Expect username (col A/0), password (col B/1) — company NOT required here
        const matchedRow = rows.find(row => {
            const sheetUsername = safeTrim(row[0]);
            const sheetPassword = safeTrim(row[1]);
            return sheetUsername === safeTrim(username) && sheetPassword === safeTrim(password);
        });

        if (!matchedRow) {
            return res.status(401).json({ success: false, message: "Invalid username or password." });
        }

        // Store ONLY username in session (company will come from replacements in /generate)
        req.session.user = { username: safeTrim(username) };

        return res.json({
            success: true,
            message: "Login successful!",
        });
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
// - Replacements drive the DOCX and the COMPANY NAME for logging
// ==========================================
app.post("/generate", requireLogin, async (req, res) => {
    try {
        const replacements = req.body && typeof req.body === "object" ? req.body : {};
        let templateFile = "";

        // STRICT TEMPLATE SELECTION
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
        } else if (docType === "CFPL") { // New CFPL Invoice page
            const invoiceItems = Array.isArray(replacements.invoiceItems) ? replacements.invoiceItems : [];
            const itemCount = invoiceItems.length;

            if (itemCount > 0) {
                templateFile = `invoice${itemCount}.docx`;
            } else {
                return res.status(400).json({ error: "CFPL Invoice requires at least one item." });
            }

        } else {
            return res.status(400).json({ error: `No valid page type found: ${docType}` });
        }

        const templatePath = path.join(__dirname, "templates", templateFile);
        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ error: `Template file not found: ${templateFile}` });
        }

        const content = fs.readFileSync(templatePath, "binary");
        const zip = new PizZip(content);

        // Access the number to words function from the frontend HTML
        const htmlContent = fs.readFileSync(path.join(__dirname, 'public', 'invoice.html'), 'utf8');
        const dom = new JSDOM(htmlContent, { runScripts: "outside-only" });
        const window = dom.window;

        // Calculate totals on the server side to ensure consistency
        let totalGovt = 0;
        let totalProfessional = 0;
        const invoiceItems = Array.isArray(replacements.invoiceItems) ? replacements.invoiceItems : [];
        invoiceItems.forEach(item => {
            totalGovt += parseFloat(item.govtFee) || 0;
            totalProfessional += parseFloat(item.professionalFee) || 0;
        });
        const grandTotal = totalGovt + totalProfessional;

        // Add the totals and words to the replacements object
        replacements.TOTAL_GOVT = totalGovt.toFixed(2);
        replacements.TOTAL_PROFESSIONAL = totalProfessional.toFixed(2);
        replacements.GRAND_TOTAL = grandTotal.toFixed(2);
        // Using the same conversion logic from the frontend
        replacements.GRAND_TOTAL_WORDS = window.numberToIndianWords(grandTotal);

        Object.keys(zip.files).forEach((filename) => {
            if (
                /word\/document\.xml$/.test(filename) ||
                /word\/footer[0-9]*\.xml$/.test(filename) ||
                /word\/header[0-9]*\.xml$/.test(filename)
            ) {
                let xml = zip.files[filename].asText();

                // === Replace generic placeholders from "replacements" ===
                for (const [key, value] of Object.entries(replacements)) {
                    // Skip arrays for now as they are handled separately
                    if (key === "directors" || key === "partners" || key === "invoiceItems") continue;
                    const regex = new RegExp(`{{${escapeRegExp(key)}}}`, "g");
                    xml = xml.replace(regex, value != null ? String(value) : "");
                }

                // === Handle arrays ===
                if (docType === "CFPL" && Array.isArray(replacements.invoiceItems)) {
                    replacements.invoiceItems.forEach((item, index) => {
                        const idx = index + 1;
                        [
                            [`D${idx}`, item.description],
                            [`GT${idx}`, item.govtFee?.toFixed(2)],
                            [`P${idx}`, item.professionalFee?.toFixed(2)],
                        ].forEach(([ph, val]) => {
                            const r = new RegExp(`{{${escapeRegExp(ph)}}}`, "g");
                            xml = xml.replace(r, val != null ? String(val) : "");
                        });
                    });
                }
                
                if (docType === "GST Resolution" && Array.isArray(replacements.directors)) {
                    replacements.directors.forEach((director, index) => {
                        const idx = index + 1;
                        [
                            [`PERSON_${idx}`, director?.name],
                            [`PERSON_${idx}_D`, director?.designation],
                            [`PERSON_${idx}_DIN`, director?.din],
                        ].forEach(([ph, val]) => {
                            const r = new RegExp(`{{${escapeRegExp(ph)}}}`, "g");
                            xml = xml.replace(r, val != null ? String(val) : "");
                        });
                    });
                }

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
                            const r = new RegExp(`{{${escapeReg-Exp(ph)}}}`, "g");
                            xml = xml.replace(r, val != null ? String(val) : "");
                        });
                    });
                }

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
                            const r = new RegExp(`{{${escapeRegExp(ph)}}}`, "g");
                            xml = xml.replace(r, val != null ? String(val) : "");
                        });
                    });
                }

                if (docType === "GST Authorization" && Array.isArray(replacements.directors)) {
                    replacements.directors.forEach((director, index) => {
                        const idx = index + 1;
                        [
                            [`PERSON_${idx}`, director?.name],
                            [`PERSON_${idx}_D`, director?.designation],
                            [`PERSON_${idx}_DIN`, director?.din],
                        ].forEach(([ph, val]) => {
                            const r = new RegExp(`{{${escapeRegExp(ph)}}}`, "g");
                            xml = xml.replace(r, val != null ? String(val) : "");
                        });
                    });
                }

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
                            const r = new RegExp(`{{${escapeRegExp(ph)}}}`, "g");
                            xml = xml.replace(r, val != null ? String(val) : "");
                        });
                    });
                }

                // Save XML back
                zip.file(filename, xml);
            }
        });

        // Generate docx
        const buf = zip.generate({ type: "nodebuffer" });

        // ===== Log ONLY on successful conversion using session username and company from replacements =====
        const { username } = req.session.user || {};
        const company = companyFromReplacements(replacements);
        await logToSheet({
            username: username || "",
            company,
            page: docType || "UNKNOWN_PAGE",
        });

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


// Serve the index.html file for the invoice page
app.get('/invoice.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'invoice.html'));
});

// ✅ Serve frontend last
app.use(express.static(path.join(__dirname, "public")));

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});