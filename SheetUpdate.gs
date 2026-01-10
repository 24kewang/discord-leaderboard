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
  const TRIGGER_FUNCTION = 'updatePoints';
  
  // Delete existing triggers for updatePoints
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create new 24-hour trigger
  ScriptApp.newTrigger(TRIGGER_FUNCTION)
    .timeBased()
    .everyDays(1)
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
  const sheet = ss.getSheetByName('Form Responses 1');
  if (!sheet) {
    throw new Error('Form Responses 1 sheet not found');
  }
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return []; // No data besides header
  
  const headers = data[0];
  const responses = [];
  
  for (let i = 1; i < data.length; i++) {
    responses.push({
      timestamp: data[i][0],
      email: data[i][1],
      eventCode: data[i][2],
      firstName: data[i][3],
      lastName: data[i][4],
      anonymous: data[i][5]
    });
  }
  
  return responses;
}

/**
 * Retrieves events from "Event Codes" sheet
 * @returns {Array} Array of event objects
 */
function getEvents(ss) {
  const sheet = ss.getSheetByName('Event Codes');
  if (!sheet) {
    throw new Error('Event Codes sheet not found');
  }
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const events = [];
  
  for (let i = 1; i < data.length; i++) {
    events.push({
      date: data[i][0],
      startTime: data[i][1],
      endTime: data[i][2],
      eventName: data[i][3],
      eventType: data[i][4],
      eventCode: data[i][5]
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
    const code = event.eventCode;
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
  const sheet = ss.getSheetByName('Points System');
  if (!sheet) {
    throw new Error('Points System sheet not found');
  }
  
  const data = sheet.getDataRange().getValues();
  const pointsMap = new Map();
  
  for (let i = 1; i < data.length; i++) {
    pointsMap.set(data[i][0], data[i][1]);
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
  const TOLERANCE_MINUTES = 30;
  const members = new Map();
  
  // Traverse in reverse order (most recent first)
  for (let i = formResponses.length - 1; i >= 0; i--) {
    const response = formResponses[i];
    
    // Check if event code is valid
    if (!eventLookup.has(response.eventCode)) {
      continue;
    }
    
    // Find matching event with valid timestamp
    const eventIndices = eventLookup.get(response.eventCode);
    let validEvent = null;
    
    for (const idx of eventIndices) {
      const event = events[idx];
      if (isValidSubmission(
        response.timestamp,
        event.date,
        event.startTime,
        event.endTime,
        TOLERANCE_MINUTES
      )) {
        validEvent = event;
        break;
      }
    }
    
    if (!validEvent) {
      continue; // No valid event found for this submission
    }
    
    // Get point value for this event type
    const pointIncrement = eventPoints.get(validEvent.eventType) || 1;
    
    // Extract netID and update member
    const netID = extractNetID(response.email);
    
    if (!members.has(netID)) {
      // Create new member
      members.set(netID, {
        firstName: response.firstName,
        lastName: response.lastName,
        anonymous: response.anonymous && response.anonymous.toString().toLowerCase().includes('yes'),
        points: pointIncrement,
        lastUpdate: response.timestamp
      });
    } else {
      // Update existing member (only increment points)
      const member = members.get(netID);
      member.points += pointIncrement;
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
  const sheet = ss.getSheetByName('Points Record');
  if (!sheet) {
    throw new Error('Points Record sheet not found');
  }
  
  // Clear existing data (keep headers)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clear();
  }
  
  // Prepare data for output
  const outputData = [];
  members.forEach((member, netID) => {
    outputData.push([
      netID,
      member.firstName,
      member.lastName,
      member.anonymous ? 'Yes' : 'No',
      member.points,
      member.lastUpdate
    ]);
  });
  
  // Write data to sheet
  if (outputData.length > 0) {
    sheet.getRange(2, 1, outputData.length, 6).setValues(outputData);
  }
}