// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  TOLERANCE_MINUTES: 30,
  DEFAULT_POINTS: 1,
  TRIGGER_INTERVAL_DAYS: 1,
  TRIGGER_FUNCTION_NAME: 'updatePoints'
};

const SHEET_NAMES = {
  FORM_RESPONSES: 'Form Responses 1',
  EVENT_CODES: 'Event Codes',
  POINTS_SYSTEM: 'Points System',
  POINTS_RECORD: 'Points Record'
};

const FORM_COLUMNS = {
  TIMESTAMP: 0,
  EMAIL: 1,
  EVENT_CODE: 2,
  FIRST_NAME: 3,
  LAST_NAME: 4,
  ANONYMOUS: 5
};

const EVENT_COLUMNS = {
  DATE: 0,
  START_TIME: 1,
  END_TIME: 2,
  EVENT_NAME: 3,
  EVENT_TYPE: 4,
  EVENT_CODE: 5
};

const POINTS_COLUMNS = {
  EVENT_TYPE: 0,
  POINTS: 1
};

const RECORD_COLUMNS = {
  NET_ID: 0,
  FIRST_NAME: 1,
  LAST_NAME: 2,
  ANONYMOUS: 3,
  POINTS: 4,
  LAST_UPDATE: 5
};

const MEMBER_FIELDS = {
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  ANONYMOUS: 'anonymous',
  POINTS: 'points',
  LAST_UPDATE: 'lastUpdate'
};

const EVENT_FIELDS = {
  DATE: 'date',
  START_TIME: 'startTime',
  END_TIME: 'endTime',
  EVENT_NAME: 'eventName',
  EVENT_TYPE: 'eventType',
  EVENT_CODE: 'eventCode'
};

const RESPONSE_FIELDS = {
  TIMESTAMP: 'timestamp',
  EMAIL: 'email',
  EVENT_CODE: 'eventCode',
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  ANONYMOUS: 'anonymous'
};

// ============================================================================
// MENU AND TRIGGER SETUP
// ============================================================================

/**
 * Creates custom menu when spreadsheet is opened
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Leaderboard Manager')
    .addItem('Set Up Auto-Update (24hr)', 'createTimeTrigger')
    .addItem('Update Points', 'updatePoints')
    .addToUi();
}

/**
 * Creates a time-based trigger to run updatePoints every 24 hours
 * Ensures only one trigger exists by deleting any existing triggers first
 */
function createTimeTrigger() {
  // Delete existing triggers for updatePoints
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === CONFIG.TRIGGER_FUNCTION_NAME) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create new trigger
  ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION_NAME)
    .timeBased()
    .everyDays(CONFIG.TRIGGER_INTERVAL_DAYS)
    .create();
  
  SpreadsheetApp.getUi().alert('Auto-update trigger created! Points will update every 24 hours.');
}

// ============================================================================
// MAIN UPDATE LOGIC
// ============================================================================

/**
 * Main function to update leaderboard points based on form submissions
 */
function updatePoints() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Retrieve data from sheets
  const formResponses = getFormResponses(ss);
  const events = getEvents(ss);
  const eventLookup = createEventLookup(events);
  const eventPoints = getEventPoints(ss);
  
  // Process form submissions
  const members = processFormSubmissions(formResponses, events, eventLookup, eventPoints);
  
  // Update Points Record sheet
  updatePointsRecord(ss, members);
  
  Logger.log('Points updated successfully!');
}

// ============================================================================
// DATA RETRIEVAL FUNCTIONS
// ============================================================================

/**
 * Retrieves form responses from "Form Responses 1" sheet
 * @returns {Array} Array of form response objects
 */
function getFormResponses(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.FORM_RESPONSES);
  if (!sheet) {
    throw new Error(`${SHEET_NAMES.FORM_RESPONSES} sheet not found`);
  }
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return []; // No data besides header
  
  const responses = [];
  
  for (let i = 1; i < data.length; i++) {
    responses.push({
      [RESPONSE_FIELDS.TIMESTAMP]: data[i][FORM_COLUMNS.TIMESTAMP],
      [RESPONSE_FIELDS.EMAIL]: data[i][FORM_COLUMNS.EMAIL],
      [RESPONSE_FIELDS.EVENT_CODE]: data[i][FORM_COLUMNS.EVENT_CODE],
      [RESPONSE_FIELDS.FIRST_NAME]: data[i][FORM_COLUMNS.FIRST_NAME],
      [RESPONSE_FIELDS.LAST_NAME]: data[i][FORM_COLUMNS.LAST_NAME],
      [RESPONSE_FIELDS.ANONYMOUS]: data[i][FORM_COLUMNS.ANONYMOUS]
    });
  }
  
  return responses;
}

/**
 * Retrieves events from "Event Codes" sheet
 * @returns {Array} Array of event objects
 */
function getEvents(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.EVENT_CODES);
  if (!sheet) {
    throw new Error(`${SHEET_NAMES.EVENT_CODES} sheet not found`);
  }
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const events = [];
  
  for (let i = 1; i < data.length; i++) {
    events.push({
      [EVENT_FIELDS.DATE]: data[i][EVENT_COLUMNS.DATE],
      [EVENT_FIELDS.START_TIME]: data[i][EVENT_COLUMNS.START_TIME],
      [EVENT_FIELDS.END_TIME]: data[i][EVENT_COLUMNS.END_TIME],
      [EVENT_FIELDS.EVENT_NAME]: data[i][EVENT_COLUMNS.EVENT_NAME],
      [EVENT_FIELDS.EVENT_TYPE]: data[i][EVENT_COLUMNS.EVENT_TYPE],
      [EVENT_FIELDS.EVENT_CODE]: data[i][EVENT_COLUMNS.EVENT_CODE]
    });
  }
  
  return events;
}

/**
 * Creates a lookup map from event codes to event indices
 * @param {Array} events - Array of event objects
 * @returns {Map} Map of event codes to arrays of indices
 */
function createEventLookup(events) {
  const lookup = new Map();
  
  events.forEach((event, index) => {
    const code = event[EVENT_FIELDS.EVENT_CODE];
    if (!lookup.has(code)) {
      lookup.set(code, []);
    }
    lookup.get(code).push(index);
  });
  
  return lookup;
}

/**
 * Retrieves event points from "Points System" sheet
 * @returns {Map} Map of event types to point values
 */
function getEventPoints(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.POINTS_SYSTEM);
  if (!sheet) {
    throw new Error(`${SHEET_NAMES.POINTS_SYSTEM} sheet not found`);
  }
  
  const data = sheet.getDataRange().getValues();
  const pointsMap = new Map();
  
  for (let i = 1; i < data.length; i++) {
    pointsMap.set(data[i][POINTS_COLUMNS.EVENT_TYPE], data[i][POINTS_COLUMNS.POINTS]);
  }
  
  return pointsMap;
}

// ============================================================================
// VALIDATION AND PROCESSING FUNCTIONS
// ============================================================================

/**
 * Validates if a form submission is within the allowed time window
 * @param {Date} timestamp - Form submission timestamp
 * @param {Date} eventDate - Event date
 * @param {Date} startTime - Event start time
 * @param {Date} endTime - Event end time
 * @param {number} toleranceMinutes - Tolerance in minutes
 * @returns {boolean} True if valid
 */
function isValidSubmission(timestamp, eventDate, startTime, endTime, toleranceMinutes) {
  // Check if dates match
  const tsDate = new Date(timestamp);
  const evDate = new Date(eventDate);
  
  if (tsDate.toDateString() !== evDate.toDateString()) {
    return false;
  }
  
  // Extract time components
  const submissionTime = tsDate.getTime();
  
  // Create datetime objects for start and end times with the event date
  const startDateTime = new Date(evDate);
  const startTimeDate = new Date(startTime);
  startDateTime.setHours(startTimeDate.getHours(), startTimeDate.getMinutes(), 0, 0);
  
  const endDateTime = new Date(evDate);
  const endTimeDate = new Date(endTime);
  endDateTime.setHours(endTimeDate.getHours(), endTimeDate.getMinutes(), 0, 0);
  
  // Apply tolerance
  const toleranceMs = toleranceMinutes * 60 * 1000;
  const allowedStart = startDateTime.getTime() - toleranceMs;
  const allowedEnd = endDateTime.getTime() + toleranceMs;
  
  return submissionTime >= allowedStart && submissionTime <= allowedEnd;
}

/**
 * Extracts netID from email address
 * @param {string} email - Email address
 * @returns {string} NetID (username before @)
 */
function extractNetID(email) {
  return email.split('@')[0];
}

/**
 * Processes all form submissions and builds member map
 * @param {Array} formResponses - Array of form responses
 * @param {Array} events - Array of events
 * @param {Map} eventLookup - Event code lookup map
 * @param {Map} eventPoints - Event points map
 * @returns {Map} Map of netIDs to member objects
 */
function processFormSubmissions(formResponses, events, eventLookup, eventPoints) {
  const members = new Map();
  const submittedEvents = new Map(); // Map of netID to Set of event indices
  
  // Traverse in reverse order (most recent first)
  for (let i = formResponses.length - 1; i >= 0; i--) {
    const response = formResponses[i];
    
    // Check if event code is valid
    if (!eventLookup.has(response[RESPONSE_FIELDS.EVENT_CODE])) {
      continue;
    }
    
    // Extract netID early for duplicate checking
    const netID = extractNetID(response[RESPONSE_FIELDS.EMAIL]);
    
    // Find matching event with valid timestamp
    const eventIndices = eventLookup.get(response[RESPONSE_FIELDS.EVENT_CODE]);
    let validEventIndex = null;
    let validEvent = null;
    
    for (const idx of eventIndices) {
      // Check if this user already submitted for this event
      if (submittedEvents.has(netID) && submittedEvents.get(netID).has(idx)) {
        continue; // Skip duplicate submission
      }
      
      const event = events[idx];
      if (isValidSubmission(
        response[RESPONSE_FIELDS.TIMESTAMP],
        event[EVENT_FIELDS.DATE],
        event[EVENT_FIELDS.START_TIME],
        event[EVENT_FIELDS.END_TIME],
        CONFIG.TOLERANCE_MINUTES
      )) {
        validEvent = event;
        validEventIndex = idx;
        break;
      }
    }
    
    if (!validEvent) {
      continue; // No valid event found for this submission
    }
    
    // Record this submission to prevent duplicates
    if (!submittedEvents.has(netID)) {
      submittedEvents.set(netID, new Set());
    }
    submittedEvents.get(netID).add(validEventIndex);
    
    // Get point value for this event type
    const pointIncrement = eventPoints.get(validEvent[EVENT_FIELDS.EVENT_TYPE]) || CONFIG.DEFAULT_POINTS;
    
    if (!members.has(netID)) {
      // Create new member
      members.set(netID, {
        [MEMBER_FIELDS.FIRST_NAME]: response[RESPONSE_FIELDS.FIRST_NAME],
        [MEMBER_FIELDS.LAST_NAME]: response[RESPONSE_FIELDS.LAST_NAME],
        [MEMBER_FIELDS.ANONYMOUS]: response[RESPONSE_FIELDS.ANONYMOUS] && 
                                    !response[RESPONSE_FIELDS.ANONYMOUS].toString().toLowerCase().includes('yes'),
        [MEMBER_FIELDS.POINTS]: pointIncrement,
        [MEMBER_FIELDS.LAST_UPDATE]: response[RESPONSE_FIELDS.TIMESTAMP]
      });
    } else {
      // Update existing member (only increment points)
      const member = members.get(netID);
      member[MEMBER_FIELDS.POINTS] += pointIncrement;
    }
  }
  
  return members;
}

// ============================================================================
// OUTPUT FUNCTIONS
// ============================================================================

/**
 * Updates the Points Record sheet with member data
 * @param {SpreadsheetApp.Spreadsheet} ss - Spreadsheet object
 * @param {Map} members - Map of members
 */
function updatePointsRecord(ss, members) {
  const sheet = ss.getSheetByName(SHEET_NAMES.POINTS_RECORD);
  if (!sheet) {
    throw new Error(`${SHEET_NAMES.POINTS_RECORD} sheet not found`);
  }
  
  // Clear existing data (keep headers)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clear();
  }
  
  // Prepare data for output
  const outputData = [];
  members.forEach((member, netID) => {
    const row = [];
    row[RECORD_COLUMNS.NET_ID] = netID;
    row[RECORD_COLUMNS.FIRST_NAME] = member[MEMBER_FIELDS.FIRST_NAME];
    row[RECORD_COLUMNS.LAST_NAME] = member[MEMBER_FIELDS.LAST_NAME];
    row[RECORD_COLUMNS.ANONYMOUS] = member[MEMBER_FIELDS.ANONYMOUS] ? 'Yes' : 'No';
    row[RECORD_COLUMNS.POINTS] = member[MEMBER_FIELDS.POINTS];
    row[RECORD_COLUMNS.LAST_UPDATE] = member[MEMBER_FIELDS.LAST_UPDATE];
    outputData.push(row);
  });
  
  // Write data to sheet
  if (outputData.length > 0) {
    sheet.getRange(2, 1, outputData.length, 6).setValues(outputData);
  }
}