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
  // Points are tracked per semester, in sheets named "{SemesterCode} {suffix}"
  // (e.g. "SP26 Points Record"). Mirrors POINTS_SHEET_SUFFIX in index.js.
  POINTS_RECORD_SUFFIX: 'Points Record',
  // Combined all-time record across every response. Kept for bookkeeping only;
  // the Discord bot reads the per-semester sheets instead.
  POINTS_RECORD: 'Points Record'
};

const RECORD_HEADER = ['NetID', 'First Name', 'Last Name', 'Anonymous', 'Points', 'Last Update'];

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
 * Main function to update leaderboard points based on form submissions.
 * Responses are split by the semester their own timestamp falls in, and each
 * semester gets its own "{SemesterCode} Points Record" sheet. A combined
 * "Points Record" sheet covering every response is also written for bookkeeping.
 */
function updatePoints() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Retrieve data from sheets
  const formResponses = getFormResponses(ss);
  const events = getEvents(ss);
  const eventLookup = createEventLookup(events);
  const eventPoints = getEventPoints(ss);

  // Split responses by semester, then process each semester independently
  const semesterBuckets = bucketFormSubmissionsBySemester(formResponses);
  const updatedSheets = [];

  semesterBuckets.forEach((responses, semesterCode) => {
    const members = processFormSubmissions(responses, events, eventLookup, eventPoints);
    const sheetName = getPointsRecordSheetName(semesterCode);

    updatePointsRecord(ss, sheetName, members);
    updatedSheets.push(sheetName);
  });

  // Also keep the combined all-time record across every response. This is for
  // bookkeeping only — the Discord bot reads the per-semester sheets.
  const allMembers = processFormSubmissions(formResponses, events, eventLookup, eventPoints);
  updatePointsRecord(ss, SHEET_NAMES.POINTS_RECORD, allMembers);

  Logger.log(updatedSheets.length > 0
    ? `Points updated successfully for: ${updatedSheets.join(', ')}, and ${SHEET_NAMES.POINTS_RECORD}`
    : `Points updated: no responses fell within a tracked semester, so only ${SHEET_NAMES.POINTS_RECORD} was written.`);
}

/**
 * Builds the sheet name that holds a semester's points record
 * @param {string} semesterCode - Semester code such as SP26 or FA25
 * @returns {string} Sheet name, e.g. "SP26 Points Record"
 */
function getPointsRecordSheetName(semesterCode) {
  return `${semesterCode} ${SHEET_NAMES.POINTS_RECORD_SUFFIX}`;
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
 * Classifies a single form response into a semester by its own timestamp.
 * Spring runs Jan-May and Fall runs Aug-Dec; Jun/Jul fall outside both, so
 * responses from those months belong to no semester and are skipped.
 * @param {Date|string} timestamp - Form submission timestamp
 * @returns {string|null} Semester code such as SP26, or null if out of range
 */
function getSemesterForResponseDate(timestamp) {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return null;

  const month = date.getMonth(); // 0 = January ... 11 = December
  const yy = (date.getFullYear() % 100).toString().padStart(2, '0');

  if (month >= 0 && month <= 4) return `SP${yy}`;   // Jan-May
  if (month >= 7 && month <= 11) return `FA${yy}`;  // Aug-Dec

  return null; // Jun/Jul
}

/**
 * Groups form responses by the semester their timestamp falls in, preserving
 * the original row order within each group
 * @param {Array} formResponses - Array of form responses
 * @returns {Map} Map of semester codes to arrays of responses
 */
function bucketFormSubmissionsBySemester(formResponses) {
  const buckets = new Map();

  formResponses.forEach(response => {
    const semesterCode = getSemesterForResponseDate(response[RESPONSE_FIELDS.TIMESTAMP]);

    if (!semesterCode) {
      Logger.log(`Skipping response outside any semester (Jun/Jul or invalid date): ` +
                 `${response[RESPONSE_FIELDS.EMAIL]} at ${response[RESPONSE_FIELDS.TIMESTAMP]}`);
      return;
    }

    if (!buckets.has(semesterCode)) {
      buckets.set(semesterCode, []);
    }
    buckets.get(semesterCode).push(response);
  });

  return buckets;
}

/**
 * Computes the anonymity flag for a response. The form question is an opt-in
 * ("show my name?"), so containing "yes" means NOT anonymous; anything else
 * (blank, "No", typos) defaults to anonymous.
 * @param {Object} response - A single form response
 * @returns {boolean} True if this response should be treated as anonymous
 */
function computeAnonymousFlag(response) {
  const anonymousValue = response[RESPONSE_FIELDS.ANONYMOUS];
  return !anonymousValue || !anonymousValue.toString().toLowerCase().includes('yes');
}

/**
 * Overwrites a member's profile fields (name, anonymity, last update) if this
 * response is strictly more recent than what's already stored, so the
 * profile always reflects the person's latest submission regardless of what
 * order the responses were processed in. Unparsable timestamps are ignored
 * rather than allowed to clobber a good value.
 * @param {Object} member - The member object to update in place
 * @param {Object} response - A candidate form response
 */
function updateMemberProfileIfNewer(member, response) {
  const responseTimestamp = new Date(response[RESPONSE_FIELDS.TIMESTAMP]);
  if (isNaN(responseTimestamp.getTime())) return;

  const currentTimestamp = new Date(member[MEMBER_FIELDS.LAST_UPDATE]);
  if (!isNaN(currentTimestamp.getTime()) && responseTimestamp <= currentTimestamp) return;

  member[MEMBER_FIELDS.FIRST_NAME] = response[RESPONSE_FIELDS.FIRST_NAME];
  member[MEMBER_FIELDS.LAST_NAME] = response[RESPONSE_FIELDS.LAST_NAME];
  member[MEMBER_FIELDS.ANONYMOUS] = computeAnonymousFlag(response);
  member[MEMBER_FIELDS.LAST_UPDATE] = response[RESPONSE_FIELDS.TIMESTAMP];
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

  // Iteration order does not matter for correctness: profile fields (name,
  // anonymity, last update) are decided by comparing each response's own
  // timestamp, not by which one is visited first.
  formResponses.forEach(response => {
    const netID = extractNetID(response[RESPONSE_FIELDS.EMAIL]);

    if (!members.has(netID)) {
      members.set(netID, {
        [MEMBER_FIELDS.FIRST_NAME]: response[RESPONSE_FIELDS.FIRST_NAME],
        [MEMBER_FIELDS.LAST_NAME]: response[RESPONSE_FIELDS.LAST_NAME],
        [MEMBER_FIELDS.ANONYMOUS]: computeAnonymousFlag(response),
        [MEMBER_FIELDS.POINTS]: 0,
        [MEMBER_FIELDS.LAST_UPDATE]: response[RESPONSE_FIELDS.TIMESTAMP]
      });
    } else {
      updateMemberProfileIfNewer(members.get(netID), response);
    }

    // Check if event code is valid
    if (!eventLookup.has(response[RESPONSE_FIELDS.EVENT_CODE])) {
      return;
    }

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
      return; // No valid event found for this submission
    }

    // Record this submission to prevent duplicates
    if (!submittedEvents.has(netID)) {
      submittedEvents.set(netID, new Set());
    }
    submittedEvents.get(netID).add(validEventIndex);

    // Get point value for this event type
    const pointIncrement = eventPoints.get(validEvent[EVENT_FIELDS.EVENT_TYPE]) || CONFIG.DEFAULT_POINTS;

    // Update member points
    const member = members.get(netID);
    member[MEMBER_FIELDS.POINTS] += pointIncrement;
  });

  return members;
}

// ============================================================================
// OUTPUT FUNCTIONS
// ============================================================================

/**
 * Returns a semester's points record sheet, creating it if it does not exist
 * @param {SpreadsheetApp.Spreadsheet} ss - Spreadsheet object
 * @param {string} sheetName - Sheet name, e.g. "SP26 Points Record"
 * @returns {SpreadsheetApp.Sheet} The existing or newly created sheet
 */
function getOrCreateSemesterSheet(ss, sheetName) {
  const existingSheet = ss.getSheetByName(sheetName);
  if (existingSheet) return existingSheet;

  Logger.log(`Creating new sheet: ${sheetName}`);
  return ss.insertSheet(sheetName);
}

/**
 * Overwrites a semester's points record sheet with member data. The sheet is
 * cleared in full (header included) and rewritten, so stale rows from a
 * previous run can never survive.
 * @param {SpreadsheetApp.Spreadsheet} ss - Spreadsheet object
 * @param {string} sheetName - Sheet to write, e.g. "SP26 Points Record"
 * @param {Map} members - Map of members
 */
function updatePointsRecord(ss, sheetName, members) {
  const sheet = getOrCreateSemesterSheet(ss, sheetName);

  // Clear values only, so any manual formatting on the sheet survives
  sheet.clearContents();

  // Prepare data for output, starting with the header row
  const outputData = [RECORD_HEADER];
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

  // Write header and data in a single pass
  sheet.getRange(1, 1, outputData.length, RECORD_HEADER.length).setValues(outputData);
}