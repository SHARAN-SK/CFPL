const express = require("express");
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip"); // Corrected package name
const { google } = require("googleapis");
const dotenv = require("dotenv");
const session = require("express-session");
const fetch = require("node-fetch");
const AdmZip = require("adm-zip");
const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const fsf = require("fs").promises;
const cheerio = require("cheerio");

dotenv.config();

const app = express();
app.use(express.json());

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
// GEMINI API SETUP (New section)
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in the .env file.");
    process.exit(1); // Exit if the API key is not found
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ==========================================
// TEMPLATE SYNC FROM GITHUB (Updated Logic)
// ==========================================
const ZIP_URL = "https://github.com/SHARAN-SK/CFPL/archive/refs/heads/main.zip";
const LOCAL_DIR = path.join(__dirname, "templates");
const META_FILE = path.join(__dirname, ".last_sync");

/**
 * Fetches the SHA of the latest commit affecting the 'templates' directory on GitHub.
 * @returns {Promise<string|null>} The commit SHA or null if not found.
 */
async function getLatestCommitSHA() {
    const apiUrl = "https://api.github.com/repos/SHARAN-SK/CFPL/commits?path=templates&per_page=1";
    const res = await fetch(apiUrl, {
        headers: { "User-Agent": "CFPL-App" } // GitHub requires a User-Agent header
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const data = await res.json();
    return data[0]?.sha || null;
}

/**
 * Syncs document templates from a GitHub repository if they have been updated.
 */
async function syncTemplates() {
    try {
        const latestSHA = await getLatestCommitSHA();
        if (!latestSHA) {
            console.log("⚠️ Could not fetch commit SHA, skipping sync.");
            return;
        }

        // Read the saved SHA from the local meta file
        let savedSHA = null;
        if (fs.existsSync(META_FILE)) {
            savedSHA = fs.readFileSync(META_FILE, "utf8").trim();
        }

        // Compare the latest SHA with the saved one
        if (savedSHA === latestSHA) {
            console.log("⏩ Templates are already up to date. Skipping download.");
            return;
        }

        console.log("⏳ Templates changed, syncing from GitHub...");
        const res = await fetch(ZIP_URL);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const buffer = await res.buffer();

        const zipPath = path.join(__dirname, "cfpl-main.zip");
        fs.writeFileSync(zipPath, buffer);

        const zip = new AdmZip(zipPath);
        const entryName = "CFPL-main/templates/";
        zip.extractEntryTo(entryName, LOCAL_DIR, true, true);

        // Save the new SHA to the meta file for future checks
        fs.writeFileSync(META_FILE, latestSHA);

        console.log("✅ Templates synced successfully!");
    } catch (err) {
        console.error("❌ Failed to sync templates:", err);
    }
}


// ==========================================
// UTILS
// ==========================================
const USER_SHEET_NAME = "USER"; // login lookup
const LOG_SHEET_NAME = "LOGS";  // Username | Company | Page | Timestamp (IST)

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
// NEW ENDPOINT FOR COMBINED DESCRIPTION
// ==========================================
app.post('/api/fetch-combined-description', requireLogin, async (req, res) => {
    try {
        const { businessNatures } = req.body;

        if (!Array.isArray(businessNatures) || businessNatures.length === 0) {
            return res.status(400).json({ error: 'At least one business nature keyword is required.' });
        }

       const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const generationPromises = businessNatures.map(async (keyword) => {
            const prompt = `I will provide a single business domain or keyword (e.g., "Real Estate", "IT Services", "Healthcare"). 
            Generate a professional business object statement that: 
            - Starts with "To carry on the business of..." 
            - Clearly lists the core activities of that industry. 
            - Ends with "and all other matters incidental or ancillary thereto, subject always to compliance with applicable laws and regulations." 
            - Must be concise and strictly limited to a maximum of 80 words. 
            Here is the keyword: "${keyword}"`;
            
            const result = await model.generateContent(prompt);
            return result.response.text();
        });

        const descriptions = await Promise.all(generationPromises);
        const combinedDescription = descriptions.join('; ');

        res.json({ description: combinedDescription });

    } catch (error) {
        console.error('Error calling Gemini API for combined description:', error);
        res.status(500).json({ error: 'Failed to generate combined business description.' });
    }
});


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
                            [`C${idx}`, director?.shareCalculated],
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

// MCA Fetch endpoint (placeholder - implement actual MCA API logic)
app.get("/api/mca-fetch", async (req, res) => {
    const companyName = req.query.name;
    
    try {
        // This is a placeholder for MCA API integration
        // You would implement actual MCA API calls here
        const data = {
            CIN: "Sample CIN for " + companyName,
            "Date of Incorporation": "01-01-2020",
            Activity: "Sample Activity",
            Directors: [
                { Name: "Sample Director 1", DIN: "12345678", Designation: "Director" },
                { Name: "Sample Director 2", DIN: "87654321", Designation: "Director" }
            ],
            Address: "Sample Address for " + companyName
        };
        
        res.json({
            "status": 200,
            "data": data
        });
    } catch (err) {
        console.error("❌ MCA Fetch Error:", err.message);
        res.json({"status": 404, "error": err.message});
    }
});

// Original getdata endpoint (for backward compatibility) - uses Falcon
app.get("/api/getdata", async (req, res) => {
  const companyName = req.query.name;

  const browser = await puppeteer.launch({ 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  try {
    // Go to homepage
    await page.goto("https://www.falconebiz.com/", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Wait for search input to be ready
    await page.waitForSelector("#com", { visible: true, timeout: 1000 });
    await page.click("#com");

    // Type company name
    await page.type("#search-com input.company-input", companyName, { delay: 5 });

    // Wait for and click first suggestion
    await page.waitForSelector("ul.ui-autocomplete li:first-child div", {
      visible: true,
      timeout: 15000,
    });
    await page.click("ul.ui-autocomplete li:first-child div");

    // IMPROVED: Better navigation detection
    await page.waitForFunction(
      () => {
        const path = window.location.pathname;
        return path.startsWith("/LLP/") || 
               path.startsWith("/company/") ||
               /^\/[A-Z]{3}/.test(path); // Matches URLs starting with 3 capital letters
      },
      { timeout: 15000 }
    );

    // Wait for main content table
    await page.waitForSelector("table.table", { timeout: 10000 });

    const url = page.url();
    console.log("Captured URL:", url);
    const html = await page.content();

    // Parse with Cheerio
    const $ = cheerio.load(html);
    
    // IMPROVED: More robust company type detection
    const isLLP = url.includes("/LLP/") || 
                  $("td:contains('LLPIN')").length > 0 ||
                  companyName.toUpperCase().includes("LLP");
    
    console.log(`🔍 Company Type Detection: isLLP=${isLLP}, URL=${url}`);
    
    // Initialize data object
    const data = {
      [isLLP ? "LLPIN" : "CIN"]: "",
      "Date of Incorporation": "",
      Activity: "",
      Directors: [],
      Address: "",
    };
    console.log(`📊 Initial data structure:`, data);

    // --- Extract Company Info ---
    let tableCount = 0;
    $("table.table.table-striped.text-left").each((tableIndex, table) => {
      tableCount++;
      const $table = $(table);
      console.log(`🔍 Processing table ${tableIndex + 1}:`);
      
      $table.find("tr").each((rowIndex, row) => {
        const $row = $(row);
        const tds = $row.find("td");
        if (tds.length >= 2) {
          const label = tds.first().text().trim();
          const value = tds.last().text().trim();
          console.log(`   Row ${rowIndex + 1}: "${label}" = "${value}"`);

          switch (label) {
            case "LLPIN":
              if (isLLP) {
                data.LLPIN = value;
                console.log(`✅ Found LLPIN: ${value}`);
              }
              break;
            case "CIN":
              if (!isLLP) {
                data.CIN = value;
                console.log(`✅ Found CIN: ${value}`);
              }
              break;
            case "Date of Incorporation":
              data["Date of Incorporation"] = value.replace(
                /(\d+)(st|nd|rd|th)/g,
                "$1"
              );
              console.log(`✅ Found Date: ${data["Date of Incorporation"]}`);
              break;
            case "Activity":
              data.Activity = value;
              console.log(`✅ Found Activity: ${value}`);
              break;
          }
        }
      });
    });
    console.log(`📋 Total tables processed: ${tableCount}`);

    // --- Extract Directors ---
    const directorsTable = $("table.table.table-striped.text-left.m-table").first();
    if (directorsTable.length > 0) {
      console.log('📋 Processing directors table...');
      
      directorsTable.find("tbody tr").each((i, row) => {
        const $row = $(row);

        // Use data-label attributes for mobile-responsive tables
        const dinCell = $row.find('td[data-label="DIN"]');
        const nameCell = $row.find('td[data-label="Name"]');
        const desigCell = $row.find('td[data-label="Designation"]');

        let din = "";
        if (dinCell.length) {
          const dinLink = dinCell.find("a").first();
          din = dinLink.length ? dinLink.text().trim() : dinCell.text().trim();
        }

        let name = "";
        if (nameCell.length) {
          const nameLink = nameCell.find("a").first();
          name = nameLink.length ? nameLink.text().trim() : nameCell.text().trim();
        }

        const designation = desigCell.length ? desigCell.text().trim() : "";

        if (din && name) {
          data.Directors.push({
            DIN: din,
            Name: name,
            Designation: designation,
          });
          console.log(`✅ Added director: ${name} (${din})`);
        }
      });
    }

    // --- Extract Address ---
    let addressFound = false;
    
    // Method 1: Look for "Address" label in tables
    $("table.table").each((i, table) => {
      if (addressFound) return false;
      
      $(table).find("tr").each((j, row) => {
        const $row = $(row);
        const tds = $row.find("td");
        
        if (tds.length >= 2) {
          const label = tds.first().text().trim();
          
          if (label === "Address" || /^address$/i.test(label)) {
            let addr = tds.last().clone();
            addr.find("a, strong").remove();
            let addressText = addr.text().trim().replace(/\s+/g, " ");

            // Try to get pincode from link if present
            const pincodeLink = tds.last().find('a[href*="company"]').text().trim();
            if (pincodeLink && !addressText.includes(pincodeLink)) {
              addressText += ", " + pincodeLink;
            }

            data.Address = addressText;
            addressFound = true;
            console.log(`✅ Found Address: ${addressText}`);
            return false;
          }
        }
      });
    });

    // Method 2: Fallback - extract from paragraph
    if (!data.Address) {
      const pageText = $("body").text();
      const match = pageText.match(
        /registered office address is\s+(.*?)(?:\.|Find other|Ltd|LLP)/i
      );
      if (match) {
        data.Address = match[1].replace(/\s+/g, " ").trim();
        console.log(`✅ Found Address (fallback): ${data.Address}`);
      }
    }

    console.log(`🎯 Final extracted data:`, JSON.stringify(data, null, 2));
    
    res.json({
      status: 200,
      data: data
    });
    
  } catch (err) {
    console.error("❌ Error:", err.message);
    
    try {
      const errorHtml = await page.content();
      await fsf.writeFile("error_page.html", errorHtml, "utf8");
      console.log("⚠️ Error page saved to error_page.html");
    } catch (e) {
      console.error("Could not save error page:", e.message);
    }
    
    res.json({ 
      status: 404,
      error: err.message 
    });
  } finally {
    await browser.close();
  }
});

// Falcon Fetch endpoint (redirect to getdata for now)
app.get("/api/falcon-fetch", async (req, res) => {
    // For now, just redirect to the existing getdata endpoint
    const companyName = req.query.name;
    
    try {
        // Make internal request to existing getdata endpoint
        const response = await fetch(`http://localhost:3000/api/getdata?name=${encodeURIComponent(companyName)}`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error("❌ Falcon Fetch Error:", err.message);
        res.json({"status": 404, "error": err.message});
    }
});

// ✅ Serve frontend last
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// START SERVER AFTER SYNC
// ==========================================
const PORT = 3000;
syncTemplates().then(() => {
    app.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
    });
});