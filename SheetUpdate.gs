// Configuration
const CONFIG = {
  FORM_SHEET_NAME: 'Form Responses 1',
  POINTS_SHEET_NAME: 'Points',
  VALID_EVENT_CODE: 'TEST',
  POINTS_INCREMENT: 1,
  TRIGGER_FUNCTION_NAME: 'handleFormSubmit'
};

// Column indices for Form Responses sheet (0-based)
const FORM_COLUMNS = {
  TIMESTAMP: 0,
  EMAIL: 1,
  EVENT_CODE: 2,
  FIRST_NAME: 3,
  LAST_NAME: 4
};

// Column indices for Points sheet (0-based)
const POINTS_COLUMNS = {
  USERNAME: 0,
  POINTS: 1
};

/**
 * Creates a custom menu when the spreadsheet opens
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Leaderboard Manager')
    .addItem('Initialize Form Submit Trigger', 'createFormSubmitTrigger')
    .addToUi();
}

/**
 * Creates a form submit trigger if one doesn't already exist
 */
function createFormSubmitTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const triggers = ScriptApp.getUserTriggers(ss);
  
  // Check if trigger already exists
  const triggerExists = triggers.some(trigger => 
    trigger.getHandlerFunction() === CONFIG.TRIGGER_FUNCTION_NAME &&
    trigger.getEventType() === ScriptApp.EventType.ON_FORM_SUBMIT
  );
  
  if (triggerExists) {
    SpreadsheetApp.getUi().alert('Trigger already exists!');
    return;
  }
  
  // Create the trigger
  ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION_NAME)
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();
  
  SpreadsheetApp.getUi().alert('Form submit trigger created successfully!');
}

/**
 * Handles form submissions
 * @param {Object} e - The event object from the form submit trigger
 */
function handleFormSubmit(e) {
  // Acquire lock to prevent race conditions
  const lock = LockService.getScriptLock();
  
  try {
    // Wait up to 30 seconds for the lock
    lock.waitLock(30000);
    
    processFormSubmission();
    
  } catch (error) {
    Logger.log('Error in handleFormSubmit: ' + error.toString());
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Processes the latest form submission
 */
function processFormSubmission() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const formSheet = ss.getSheetByName(CONFIG.FORM_SHEET_NAME);
  
  if (!formSheet) {
    throw new Error(`Sheet "${CONFIG.FORM_SHEET_NAME}" not found`);
  }
  
  // Get the latest submission row
  const lastRow = formSheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log('No data rows found');
    return;
  }
  
  const submissionData = formSheet.getRange(lastRow, 1, 1, 5).getValues()[0];
  
  // Extract submission details
  const email = submissionData[FORM_COLUMNS.EMAIL];
  const eventCode = submissionData[FORM_COLUMNS.EVENT_CODE];
  
  // Validate event code
  if (eventCode !== CONFIG.VALID_EVENT_CODE) {
    Logger.log(`Invalid event code: ${eventCode}. Expected: ${CONFIG.VALID_EVENT_CODE}`);
    return;
  }
  
  // Extract username from email
  const username = extractUsername(email);
  if (!username) {
    Logger.log(`Invalid email format: ${email}`);
    return;
  }

  // Update points
  updateUserPoints(ss, username);
}

/**
 * Extracts username from email address
 * @param {string} email - The email address
 * @return {string} The username (part before @)
 */
function extractUsername(email) {
  if (!email || typeof email !== 'string') {
    return null;
  }
  
  const atIndex = email.indexOf('@');
  if (atIndex === -1) {
    return null;
  }
  
  return email.substring(0, atIndex);
}

/**
 * Updates or creates a user's points in the Points sheet
 * @param {Spreadsheet} ss - The active spreadsheet
 * @param {string} username - The username to update
 */
function updateUserPoints(ss, username) {
  const pointsSheet = ss.getSheetByName(CONFIG.POINTS_SHEET_NAME);
  
  if (!pointsSheet) {
    throw new Error(`Sheet "${CONFIG.POINTS_SHEET_NAME}" not found`);
  }
  
  const lastRow = pointsSheet.getLastRow();
  
  // If sheet only has headers or is empty, add first user
  if (lastRow <= 1) {
    pointsSheet.appendRow([username, CONFIG.POINTS_INCREMENT]);
    Logger.log(`Added new user: ${username} with ${CONFIG.POINTS_INCREMENT} points`);
    return;
  }
  
  // Get all usernames and points
  const data = pointsSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  
  // Search for existing user
  for (let i = 0; i < data.length; i++) {
    if (data[i][POINTS_COLUMNS.USERNAME] === username) {
      // User exists, increment points
      const currentPoints = data[i][POINTS_COLUMNS.POINTS] || 0;
      const newPoints = currentPoints + CONFIG.POINTS_INCREMENT;
      pointsSheet.getRange(i + 2, POINTS_COLUMNS.POINTS + 1).setValue(newPoints);
      Logger.log(`Updated ${username}: ${currentPoints} -> ${newPoints} points`);
      return;
    }
  }
  
  // User doesn't exist, add new row
  pointsSheet.appendRow([username, CONFIG.POINTS_INCREMENT]);
  Logger.log(`Added new user: ${username} with ${CONFIG.POINTS_INCREMENT} points`);
}