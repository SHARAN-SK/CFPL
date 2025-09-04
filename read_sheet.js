const { google } = require('googleapis');
const path = require('path');

// ==========================================
// CONFIGURATION - REPLACE WITH YOUR DETAILS
// ==========================================
const SPREADSHEET_ID = '13_BKNskgFAnwsRATz_XTY-MQ6oytt9nB3IBWxO_Mifg';
const SHEET_NAME = 'USER'; // Make sure this is an exact, case-sensitive match
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// ==========================================
// MAIN FUNCTION
// ==========================================
async function readSheet() {
  try {
    // Authenticate using the credentials.json key file
    const auth = new google.auth.GoogleAuth({
      keyFile: CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({
      version: 'v4',
      auth: auth,
    });

    // Get the data from the sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      console.log('❌ No data found in the sheet.');
      return;
    }

    console.log('✅ Data retrieved successfully:');
    console.log(rows); // Log the data to the console

  } catch (error) {
    console.error('❌ An error occurred while reading the sheet:');
    console.error(error.message); // This will show you the specific error from Google API
    console.error(error); // This will show you the full error object
  }
}

readSheet();