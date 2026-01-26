import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import moment from 'moment-timezone';

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
  DISCORD: {
    TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID,
    GUILD_ID: process.env.GUILD_ID,
    STAFF_ROLES: ['Technical', 'Membership', 'Professional'],
    ADMIN_ROLES: ['Membership']
  },
  GOOGLE_SHEETS: {
    SPREADSHEET_ID: process.env.SPREADSHEET_ID,
    CREDENTIALS_PATH: process.env.CREDENTIALS_PATH,
    EVENTS_SHEET: process.env.EVENTS_SHEET || 'Event Codes',
    POINTS_SHEET: process.env.POINTS_SHEET || 'Points Record',
    TYPES_SHEET: process.env.TYPES_SHEET || 'Points System'
  },
  TIMEZONE: 'America/Chicago',
  ASSETS: {
    ATTENDANCE_QR_PATH: './assets/attendance-qr.png'
  }
};

// Event types enum
const EVENT_TYPES = {
  GENERAL_MEETING: 'General Meeting',
  TECHNICAL_WORKSHOP: 'Technical Workshop',
  TECH_TALK: 'Tech Talk',
  SOCIAL: 'Social'
};

// Define the spreadsheet columns structure for each sheet
const SHEET_COLUMNS = {
  EVENTS: {
    DATE: 'Date',
    START_TIME: 'Start Time',
    END_TIME: 'End Time',
    EVENT_NAME: 'Event Name',
    EVENT_TYPE: 'Event Type',
    EVENT_CODE: 'Event Code'
  },
  TYPES: {
    EVENT_TYPE: 'Event Type',
    POINTS: 'Points'
  },
  POINTS: {
    NETID: 'NetID',
    FIRST_NAME: 'First Name',
    LAST_NAME: 'Last Name',
    ANONYMOUS: 'Anonymous',
    POINTS: 'Points',
    LAST_UPDATE: 'Last Update'
  }
};

// Define the order of columns in each spreadsheet (left to right)
const COLUMN_ORDER = {
  EVENTS: [
    SHEET_COLUMNS.EVENTS.DATE,
    SHEET_COLUMNS.EVENTS.START_TIME,
    SHEET_COLUMNS.EVENTS.END_TIME,
    SHEET_COLUMNS.EVENTS.EVENT_NAME,
    SHEET_COLUMNS.EVENTS.EVENT_TYPE,
    SHEET_COLUMNS.EVENTS.EVENT_CODE
  ],
  TYPES: [
    SHEET_COLUMNS.TYPES.EVENT_TYPE,
    SHEET_COLUMNS.TYPES.POINTS
  ],
  POINTS: [
    SHEET_COLUMNS.POINTS.NETID,
    SHEET_COLUMNS.POINTS.FIRST_NAME,
    SHEET_COLUMNS.POINTS.LAST_NAME,
    SHEET_COLUMNS.POINTS.ANONYMOUS,
    SHEET_COLUMNS.POINTS.POINTS,
    SHEET_COLUMNS.POINTS.LAST_UPDATE
  ]
};

// Command permission levels
const PERMISSION_LEVELS = {
  USER: 'USER',
  STAFF: 'STAFF',
  ADMIN: 'ADMIN'
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function getColumnIndex(sheetType, columnName) {
  return COLUMN_ORDER[sheetType].findIndex(col => col.toLowerCase() === columnName.toLowerCase());
}

function getSheetRange(sheetName, sheetType) {
  const lastColumn = String.fromCharCode(65 + COLUMN_ORDER[sheetType].length - 1);
  return `${sheetName}!A:${lastColumn}`;
}

function capitalize(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function getCurrentTimestamp() {
  return moment().tz(CONFIG.TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
}

function getExecutorUsername(interaction) {
  return interaction.member?.displayName || interaction.user?.username || "Unknown";
}

function checkPermissions(interaction, requiredLevel) {
  const memberRoles = interaction.member?.roles?.cache?.map((role) => role.name) || [];
  
  switch (requiredLevel) {
    case PERMISSION_LEVELS.USER:
      return true; // Anyone can execute user commands
    case PERMISSION_LEVELS.STAFF:
      return CONFIG.DISCORD.STAFF_ROLES.some((role) => memberRoles.includes(role)) ||
             CONFIG.DISCORD.ADMIN_ROLES.some((role) => memberRoles.includes(role));
    case PERMISSION_LEVELS.ADMIN:
      return CONFIG.DISCORD.ADMIN_ROLES.some((role) => memberRoles.includes(role));
    default:
      return false;
  }
}

function isAnonymous(anonymousValue) {
  if (!anonymousValue || typeof anonymousValue !== 'string') return true;
  const value = anonymousValue.toLowerCase().trim();
  return !(value === 'false' || value === 'no');
}

function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  
  // Try to parse various date formats
  const formats = [
    'M/D/YY', 'M/D/YYYY', 'MM/DD/YY', 'MM/DD/YYYY',
    'M-D-YY', 'M-D-YYYY', 'MM-DD-YY', 'MM-DD-YYYY',
    'YYYY-MM-DD', 'YYYY/MM/DD'
  ];
  
  for (const format of formats) {
    const parsed = moment(dateStr, format, true);
    if (parsed.isValid()) {
      return parsed.format('YYYY-MM-DD');
    }
  }
  
  return null;
}

function parseTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  
  // Normalize the time string
  const normalized = timeStr.trim().toLowerCase().replace(/\s+/g, '');
  
  // Try to parse various time formats
  const formats = [
    'h:mma', 'h:mm a', 'ha', 'h a',
    'H:mm', 'HH:mm', 'H', 'HH'
  ];
  
  for (const format of formats) {
    const parsed = moment(normalized, format, true);
    if (parsed.isValid()) {
      return parsed.format('h:mm A');
    }
  }
  
  return null;
}

function isTimeAfter(startTime, endTime) {
  const start = moment(startTime, 'h:mm A');
  const end = moment(endTime, 'h:mm A');
  return end.isAfter(start);
}

// ============================================================================
// LOGGING SETUP
// ============================================================================
class Logger {
  constructor() {
    this.ensureLogsDirectory();
    this.setupLogger();
  }

  ensureLogsDirectory() {
    const logsDir = path.resolve(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  }

  setupLogger() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const executor = meta.executor
            ? ` | Executor: ${meta.executor.userDisplayName} (${meta.executor.discord_id})`
            : '';
          const target = meta.target
            ? ` | Target: ${meta.target.name || 'Unknown'} (${meta.target.discord_id || 'Unknown'})`
            : '';
          const command = meta.command ? ` | Command: ${meta.command.name}` : '';
          const permissionLevel = meta.permissionLevel ? ` | Permission: ${meta.permissionLevel}` : '';
          const options = meta.options ? ` | Options: ${JSON.stringify(meta.options)}` : '';
          const before = meta.before ? ` | Before: ${JSON.stringify(meta.before)}` : '';
          const after = meta.after ? ` | After: ${JSON.stringify(meta.after)}` : '';
          const results = meta.results ? ` | Results: ${JSON.stringify(meta.results)}` : '';
          return `${timestamp} [${level.toUpperCase()}] ${message}${permissionLevel}${executor}${target}${command}${options}${before}${after}${results}`;
        })
      ),
      transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
          filename: 'logs/bot-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: '10m',
          maxFiles: '14d',
          zippedArchive: true,
        }),
      ],
    });
  }

  log(level, message, meta = {}) {
    this.logger.log(level, message, meta);
  }

  info(message, meta = {}) {
    this.log('info', message, meta);
  }

  warn(message, meta = {}) {
    this.log('warn', message, meta);
  }

  error(message, meta = {}) {
    this.log('error', message, meta);
  }
}

const logger = new Logger();

// ============================================================================
// GOOGLE SHEETS SERVICE
// ============================================================================
class GoogleSheetsService {
  constructor() {
    this.sheets = null;
  }

  async authenticate() {
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: CONFIG.GOOGLE_SHEETS.CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
      logger.info('Google Sheets authentication successful');
      return this.sheets;
    } catch (error) {
      logger.error('Google Sheets authentication failed', { error: error.message });
      throw error;
    }
  }

  async fetchSheetData(sheetName, sheetType) {
    try {
      if (!this.sheets) await this.authenticate();
      
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.GOOGLE_SHEETS.SPREADSHEET_ID,
        range: getSheetRange(sheetName, sheetType),
      });

      const data = response.data.values || [];
      
      // Ensure we have headers, if not create them
      if (data.length === 0) {
        data.push(COLUMN_ORDER[sheetType]);
      }
      
      return data;
    } catch (error) {
      logger.error('Failed to fetch sheet data', { 
        error: error.message,
        sheetName,
        sheetType
      });
      throw error;
    }
  }

  async writeSheetData(sheetName, sheetType, rows) {
    try {
      if (!this.sheets) await this.authenticate();
      
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.GOOGLE_SHEETS.SPREADSHEET_ID,
        range: getSheetRange(sheetName, sheetType),
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      });
      
      logger.info('Sheet data updated successfully', { sheetName, sheetType });
    } catch (error) {
      logger.error('Failed to write sheet data', { 
        error: error.message,
        sheetName,
        sheetType
      });
      throw error;
    }
  }
}


// ============================================================================
// COMMAND HANDLERS
// ============================================================================
class CommandHandlers {
  constructor(sheetsService) {
    this.sheetsService = sheetsService;
  }

  async handleViewLeaderboard(interaction) {
    const permissionLevel = PERMISSION_LEVELS.USER;
    
    try {
      const userDisplayName = getExecutorUsername(interaction);
      
      // Check permissions (user commands always pass)
      if (!checkPermissions(interaction, permissionLevel)) {
        logger.warn('[LEADERBOARD FAILED] Unauthorized access attempt', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'view-leaderboard' },
        });
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: ['Ephemeral'] });
        return;
      }

      const rows = await this.sheetsService.fetchSheetData(CONFIG.GOOGLE_SHEETS.POINTS_SHEET, 'POINTS');
      
      if (rows.length <= 1) {
        logger.info('[LEADERBOARD EMPTY] No data found', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username, 
            userDisplayName 
          },
          command: { name: 'view-leaderboard' },
        });
        await interaction.reply('No leaderboard data available.');
        return;
      }

      const headers = rows[0];
      const firstNameIndex = getColumnIndex('POINTS', SHEET_COLUMNS.POINTS.FIRST_NAME);
      const lastNameIndex = getColumnIndex('POINTS', SHEET_COLUMNS.POINTS.LAST_NAME);
      const pointsIndex = getColumnIndex('POINTS', SHEET_COLUMNS.POINTS.POINTS);
      const anonymousIndex = getColumnIndex('POINTS', SHEET_COLUMNS.POINTS.ANONYMOUS);

      // Process and sort data by points (descending)
      const processedData = rows.slice(1)
        .filter(row => row[pointsIndex] && !isNaN(row[pointsIndex])) // Only rows with valid points
        .map(row => {
          const firstName = row[firstNameIndex] || '';
          const lastName = row[lastNameIndex] || '';
          const fullName = `${firstName} ${lastName}`.trim() || 'Unknown';
          
          return {
            name: isAnonymous(row[anonymousIndex]) ? 'Anonymous' : fullName,
            points: parseInt(row[pointsIndex]) || 0,
            originalName: fullName
          };
        })
        .sort((a, b) => b.points - a.points)
        .slice(0, 15); // Top 15

      if (processedData.length === 0) {
        logger.info('[LEADERBOARD EMPTY / INVALID] No valid data found', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username, 
            userDisplayName 
          },
          command: { name: 'view-leaderboard' },
        });
        await interaction.reply('No valid leaderboard data available.');
        return;
      }

      let leaderboardText = '```\n🏆 LEADERBOARD - TOP 15 🏆\n\n';
      leaderboardText += 'Rank | Name                    | Points\n';
      leaderboardText += '-----|-------------------------|----------\n';
      
      processedData.forEach((row, index) => {
        const rank = (index + 1).toString().padStart(2, ' ');
        const name = row.name.padEnd(23, ' ').substring(0, 23);
        const points = Number(row.points).toLocaleString().padStart(8, ' ');
        leaderboardText += `${rank}   | ${name} | ${points}\n`;
      });
      
      leaderboardText += '```';
      
      await interaction.reply(leaderboardText);
      
      logger.info('[LEADERBOARD SUCCESS] Leaderboard generated', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username, 
          userDisplayName 
        },
        command: { name: 'view-leaderboard' },
        results: { count: processedData.length },
      });
    } catch (error) {
      logger.error('Error handling view-leaderboard command', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: getExecutorUsername(interaction)
        },
        command: { name: 'view-leaderboard' },
        error: error.message,
      });
      await interaction.reply('An error occurred while generating the leaderboard.');
    }
  }

  async handleMembershipLogs(interaction) {
    const permissionLevel = PERMISSION_LEVELS.ADMIN;
    
    try {
      const action = interaction.options.getString('action');
      const lines = interaction.options.getInteger('lines') || 10;
      const date = interaction.options.getString('date') || moment().format('YYYY-MM-DD');
      const userDisplayName = getExecutorUsername(interaction);

      // Check permissions
      if (!checkPermissions(interaction, permissionLevel)) {
        logger.warn('[LOGS FAILED] Unauthorized access attempt', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username, 
            userDisplayName 
          },
          command: { name: 'membership-logs' },
          options: { action, lines, date },
        });
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: ['Ephemeral'] });
        return;
      }

      const logFilePath = path.resolve(__dirname, `logs/bot-${date}.log`);

      switch (action) {
        case 'view':
          await this.handleLogView(interaction, logFilePath, lines, date, userDisplayName, permissionLevel);
          break;
        case 'download':
          await this.handleLogDownload(interaction, logFilePath, date, userDisplayName, permissionLevel);
          break;
      }
    } catch (error) {
      logger.error('Error handling membership-logs command', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: getExecutorUsername(interaction)
        },
        command: { name: 'membership-logs' },
        error: error.message,
      });
      await interaction.reply({ content: 'An error occurred while processing your logs command.', flags: ['Ephemeral'] });
    }
  }

  async handleLogView(interaction, logFilePath, lines, date, userDisplayName, permissionLevel) {
    if (!fs.existsSync(logFilePath)) {
      logger.warn('[LOGS VIEW FAILED] File not found', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username, 
          userDisplayName 
        },
        command: { name: 'membership-logs' },
        options: { action: 'view', lines, date },
      });
      await interaction.reply({ content: `No log file found for the specified date: ${date}.`, flags: ['Ephemeral'] });
      return;
    }

    const logData = fs.readFileSync(logFilePath, 'utf8').split('\n').slice(-lines).join('\n');
    const content = `\`\`\`log\n${logData}\n\`\`\``;

    if (content.length > 2000) {
      await interaction.reply({ content: 'Log data is too large to display. Use the "Download" option.', flags: ['Ephemeral'] });
    } else {
      await interaction.reply({ content, flags: ['Ephemeral'] });
    }

    logger.info('[LOGS VIEW SUCCESS] Logs viewed', {
      permissionLevel,
      executor: { 
        discord_id: interaction.user.id, 
        username: interaction.user.username, 
        userDisplayName 
      },
      command: { name: 'membership-logs' },
      options: { action: 'view', lines, date },
    });
  }

  async handleLogDownload(interaction, logFilePath, date, userDisplayName, permissionLevel) {
    if (!fs.existsSync(logFilePath)) {
      logger.warn('[LOGS DOWNLOAD FAILED] File not found', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username, 
          userDisplayName 
        },
        command: { name: 'membership-logs' },
        options: { action: 'download', date },
      });
      await interaction.reply({ content: `No log file found for the specified date: ${date}.`, flags: ['Ephemeral'] });
      return;
    }

    await interaction.reply({ content: `Here are the logs for ${date}:`, files: [logFilePath], flags: ['Ephemeral'] });

    logger.info('[LOGS DOWNLOAD SUCCESS] Logs downloaded', {
      permissionLevel,
      executor: { 
        discord_id: interaction.user.id, 
        username: interaction.user.username, 
        userDisplayName 
      },
      command: { name: 'membership-logs' },
      options: { action: 'download', date },
    });
  }

  async handleAddEvent(interaction) {
    const permissionLevel = PERMISSION_LEVELS.STAFF;
    
    try {
      const userDisplayName = getExecutorUsername(interaction);
      
      // Check permissions
      if (!checkPermissions(interaction, permissionLevel)) {
        logger.warn('[ADD EVENT FAILED] Unauthorized access attempt', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'add-event' },
        });
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: ['Ephemeral'] });
        return;
      }

      // Get all command options
      const eventName = interaction.options.getString('event-name');
      const dateStr = interaction.options.getString('date');
      const startTimeStr = interaction.options.getString('start-time');
      const endTimeStr = interaction.options.getString('end-time');
      const eventType = interaction.options.getString('event-type');
      const eventCode = interaction.options.getString('event-code');

      // Validate date format
      const parsedDate = parseDate(dateStr);
      if (!parsedDate) {
        logger.warn('[ADD EVENT FAILED] Invalid date format', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'add-event' },
          options: { eventName, date: dateStr, eventType, eventCode }
        });
        await interaction.reply({ 
          content: `Invalid date format: "${dateStr}". Please use a common format like MM/DD/YY, MM/DD/YYYY, or YYYY-MM-DD.`, 
          flags: ['Ephemeral'] 
        });
        return;
      }

      // Validate time formats
      const parsedStartTime = parseTime(startTimeStr);
      if (!parsedStartTime) {
        logger.warn('[ADD EVENT FAILED] Invalid start time format', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'add-event' },
          options: { eventName, date: parsedDate, startTime: startTimeStr, eventType, eventCode }
        });
        await interaction.reply({ 
          content: `Invalid start time format: "${startTimeStr}". Please use a common format like 3pm, 3:30pm, or 15:30.`, 
          flags: ['Ephemeral'] 
        });
        return;
      }

      const parsedEndTime = parseTime(endTimeStr);
      if (!parsedEndTime) {
        logger.warn('[ADD EVENT FAILED] Invalid end time format', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'add-event' },
          options: { eventName, date: parsedDate, startTime: parsedStartTime, endTime: endTimeStr, eventType, eventCode }
        });
        await interaction.reply({ 
          content: `Invalid end time format: "${endTimeStr}". Please use a common format like 5pm, 5:30pm, or 17:30.`, 
          flags: ['Ephemeral'] 
        });
        return;
      }

      // Validate that start time is before end time
      if (!isTimeAfter(parsedStartTime, parsedEndTime)) {
        logger.warn('[ADD EVENT FAILED] End time must be after start time', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'add-event' },
          options: { eventName, date: parsedDate, startTime: parsedStartTime, endTime: parsedEndTime, eventType, eventCode }
        });
        await interaction.reply({ 
          content: `End time (${parsedEndTime}) must be after start time (${parsedStartTime}).`, 
          flags: ['Ephemeral'] 
        });
        return;
      }

      // Fetch existing sheet data
      const rows = await this.sheetsService.fetchSheetData(CONFIG.GOOGLE_SHEETS.EVENTS_SHEET, 'EVENTS');
      
      // Build the new row
      const newRow = [
        parsedDate,
        parsedStartTime,
        parsedEndTime,
        eventName,
        eventType,
        eventCode
      ];
      
      // Add the new row
      rows.push(newRow);
      
      // Write back to sheet
      await this.sheetsService.writeSheetData(CONFIG.GOOGLE_SHEETS.EVENTS_SHEET, 'EVENTS', rows);
      
      logger.info('[ADD EVENT SUCCESS] Event added successfully', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName 
        },
        command: { name: 'add-event' },
        options: { 
          eventName, 
          date: parsedDate, 
          startTime: parsedStartTime, 
          endTime: parsedEndTime, 
          eventType, 
          eventCode 
        }
      });

      await interaction.reply({ 
        content: `✅ Event "${eventName}" added successfully!\n` +
                 `📅 Date: ${parsedDate}\n` +
                 `🕐 Time: ${parsedStartTime} - ${parsedEndTime}\n` +
                 `📋 Type: ${eventType}\n` +
                 `🔑 Code: ${eventCode}`,
        flags: ['Ephemeral']
      });
      
    } catch (error) {
      logger.error('Error handling add-event command', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: getExecutorUsername(interaction)
        },
        command: { name: 'add-event' },
        error: error.message,
      });
      await interaction.reply({ content: 'An error occurred while adding the event.', flags: ['Ephemeral'] });
    }
  }

  async handleShowEventList(interaction) {
    const permissionLevel = PERMISSION_LEVELS.STAFF;
    
    try {
      const userDisplayName = getExecutorUsername(interaction);
      const numberOfEvents = interaction.options.getInteger('number-of-events');
      
      // Check permissions
      if (!checkPermissions(interaction, permissionLevel)) {
        logger.warn('[SHOW EVENT LIST FAILED] Unauthorized access attempt', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'show-event-list' },
        });
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: ['Ephemeral'] });
        return;
      }

      // Fetch events data
      const rows = await this.sheetsService.fetchSheetData(CONFIG.GOOGLE_SHEETS.EVENTS_SHEET, 'EVENTS');
      
      if (rows.length <= 1) {
        logger.info('[SHOW EVENT LIST EMPTY] No events found', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'show-event-list' },
        });
        await interaction.reply({ content: 'No events available.', flags: ['Ephemeral'] });
        return;
      }

      const headers = rows[0];
      const dateIndex = getColumnIndex('EVENTS', SHEET_COLUMNS.EVENTS.DATE);
      
      // Sort events by most recent date
      const eventData = rows.slice(1)
        .map(row => ({
          date: row[dateIndex] || '',
          startTime: row[getColumnIndex('EVENTS', SHEET_COLUMNS.EVENTS.START_TIME)] || '',
          endTime: row[getColumnIndex('EVENTS', SHEET_COLUMNS.EVENTS.END_TIME)] || '',
          eventName: row[getColumnIndex('EVENTS', SHEET_COLUMNS.EVENTS.EVENT_NAME)] || '',
          eventType: row[getColumnIndex('EVENTS', SHEET_COLUMNS.EVENTS.EVENT_TYPE)] || '',
          eventCode: row[getColumnIndex('EVENTS', SHEET_COLUMNS.EVENTS.EVENT_CODE)] || '',
          sortDate: moment(row[dateIndex], 'YYYY-MM-DD', true).isValid() 
            ? moment(row[dateIndex], 'YYYY-MM-DD').valueOf() 
            : 0
        }))
        .sort((a, b) => b.sortDate - a.sortDate);

      // Limit to specified number or show all
      const displayEvents = numberOfEvents ? eventData.slice(0, numberOfEvents) : eventData;

      if (displayEvents.length === 0) {
        await interaction.reply({ content: 'No valid events to display.', flags: ['Ephemeral'] });
        return;
      }

      // Build table
      let eventListText = '```\n';
      eventListText += numberOfEvents 
        ? `📅 RECENT EVENTS (Top ${numberOfEvents})\n\n`
        : '📅 ALL EVENTS\n\n';
      eventListText += 'Date       | Time                     | Event Name           | Type                  | Code\n';
      eventListText += '-----------|--------------------------|----------------------|-----------------------|----------\n';
      
      displayEvents.forEach(event => {
        const date = event.date.padEnd(10, ' ').substring(0, 10);
        const time = `${event.startTime}-${event.endTime}`.padEnd(24, ' ').substring(0, 24);
        const name = event.eventName.padEnd(20, ' ').substring(0, 20);
        const type = event.eventType.padEnd(21, ' ').substring(0, 21);
        const code = event.eventCode.padEnd(8, ' ').substring(0, 8);
        eventListText += `${date} | ${time} | ${name} | ${type} | ${code}\n`;
      });
      
      eventListText += '```';
      
      await interaction.reply({ content: eventListText, flags: ['Ephemeral'] });
      
      logger.info('[SHOW EVENT LIST SUCCESS] Event list displayed', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName 
        },
        command: { name: 'show-event-list' },
        options: { numberOfEvents },
        results: { count: displayEvents.length }
      });
      
    } catch (error) {
      logger.error('Error handling show-event-list command', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: getExecutorUsername(interaction)
        },
        command: { name: 'show-event-list' },
        error: error.message,
      });
      await interaction.reply({ content: 'An error occurred while retrieving the event list.', flags: ['Ephemeral'] });
    }
  }

  async handleGetAttendanceQR(interaction) {
    const permissionLevel = PERMISSION_LEVELS.STAFF;
    
    try {
      const userDisplayName = getExecutorUsername(interaction);
      
      // Check permissions
      if (!checkPermissions(interaction, permissionLevel)) {
        logger.warn('[GET ATTENDANCE QR FAILED] Unauthorized access attempt', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'get-attendance-qr' },
        });
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: ['Ephemeral'] });
        return;
      }

      const qrPath = path.resolve(__dirname, CONFIG.ASSETS.ATTENDANCE_QR_PATH);
      
      if (!fs.existsSync(qrPath)) {
        logger.error('[GET ATTENDANCE QR FAILED] QR code file not found', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'get-attendance-qr' },
        });
        await interaction.reply({ 
          content: 'Attendance QR code file not found. Please contact an administrator.', 
          flags: ['Ephemeral'] 
        });
        return;
      }

      await interaction.reply({ 
        content: '📱 **Attendance QR Code**', 
        files: [qrPath],
        flags: ['Ephemeral']
      });
      
      logger.info('[GET ATTENDANCE QR SUCCESS] QR code sent', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName 
        },
        command: { name: 'get-attendance-qr' },
      });
      
    } catch (error) {
      logger.error('Error handling get-attendance-qr command', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: getExecutorUsername(interaction)
        },
        command: { name: 'get-attendance-qr' },
        error: error.message,
      });
      await interaction.reply({ content: 'An error occurred while retrieving the QR code.', flags: ['Ephemeral'] });
    }
  }

  async handleShowPointSystem(interaction) {
    const permissionLevel = PERMISSION_LEVELS.USER;
    
    try {
      const userDisplayName = getExecutorUsername(interaction);
      
      // Check permissions (user commands always pass)
      if (!checkPermissions(interaction, permissionLevel)) {
        logger.warn('[SHOW POINT SYSTEM FAILED] Unauthorized access attempt', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'show-point-system' },
        });
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: ['Ephemeral'] });
        return;
      }

      // Fetch point system data
      const rows = await this.sheetsService.fetchSheetData(CONFIG.GOOGLE_SHEETS.TYPES_SHEET, 'TYPES');
      
      if (rows.length <= 1) {
        logger.info('[SHOW POINT SYSTEM EMPTY] No point system data found', {
          permissionLevel,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName 
          },
          command: { name: 'show-point-system' },
        });
        await interaction.reply('No point system data available.');
        return;
      }

      const eventTypeIndex = getColumnIndex('TYPES', SHEET_COLUMNS.TYPES.EVENT_TYPE);
      const pointsIndex = getColumnIndex('TYPES', SHEET_COLUMNS.TYPES.POINTS);
      
      // Build the point system table
      let pointSystemText = '```\n🎯 POINT SYSTEM\n\n';
      pointSystemText += 'Event Type                | Points\n';
      pointSystemText += '--------------------------|--------\n';
      
      rows.slice(1).forEach(row => {
        const eventType = (row[eventTypeIndex] || 'Unknown').padEnd(25, ' ').substring(0, 25);
        const points = (row[pointsIndex] || '0').toString().padStart(6, ' ');
        pointSystemText += `${eventType} | ${points}\n`;
      });
      
      pointSystemText += '```';
      
      await interaction.reply(pointSystemText);
      
      logger.info('[SHOW POINT SYSTEM SUCCESS] Point system displayed', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName 
        },
        command: { name: 'show-point-system' },
        results: { count: rows.length - 1 }
      });
      
    } catch (error) {
      logger.error('Error handling show-point-system command', {
        permissionLevel,
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: getExecutorUsername(interaction)
        },
        command: { name: 'show-point-system' },
        error: error.message,
      });
      await interaction.reply('An error occurred while retrieving the point system.');
    }
  }
}

// ============================================================================
// DISCORD BOT
// ============================================================================
class DiscordBot {
  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });
    
    this.sheetsService = new GoogleSheetsService();
    this.commandHandlers = new CommandHandlers(this.sheetsService);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.once('clientReady', () => {
      logger.info(`Bot logged in as ${this.client.user.tag}`);
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.guild || !interaction.isCommand()) return;

      const { commandName } = interaction;

      try {
        switch (commandName) {
          case 'view-leaderboard':
            await this.commandHandlers.handleViewLeaderboard(interaction);
            break;
          case 'membership-logs':
            await this.commandHandlers.handleMembershipLogs(interaction);
            break;
          case 'add-event':
            await this.commandHandlers.handleAddEvent(interaction);
            break;
          case 'show-event-list':
            await this.commandHandlers.handleShowEventList(interaction);
            break;
          case 'get-attendance-qr':
            await this.commandHandlers.handleGetAttendanceQR(interaction);
            break;
          case 'show-point-system':
            await this.commandHandlers.handleShowPointSystem(interaction);
            break;
          default:
            logger.warn('Unknown command received', { commandName });
            await interaction.reply('Unknown command.');
        }
      } catch (error) {
        logger.error('Error handling interaction', {
          commandName,
          error: error.message,
          executor: { 
            discord_id: interaction.user.id, 
            username: interaction.user.username,
            userDisplayName: getExecutorUsername(interaction)
          }
        });
        
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply('An error occurred while processing your command.');
        }
      }
    });
  }

  async registerCommands() {
    const commands = [
      {
        name: 'view-leaderboard',
        description: 'View the current leaderboard showing top 15 members by points.',
      },
      {
        name: 'show-point-system',
        description: 'View the point system showing points awarded for different event types.',
      },
      {
        name: 'add-event',
        description: 'Add a new event to the events sheet. This is restricted to staff roles.',
        options: [
          { 
            name: 'event-name', 
            description: 'Name of the event', 
            type: 3, 
            required: true 
          },
          { 
            name: 'date', 
            description: 'Event date (use a valid format like MM/DD/YY or YYYY-MM-DD)', 
            type: 3, 
            required: true 
          },
          { 
            name: 'start-time', 
            description: 'Event start time (use a valid format like 3pm or 15:00)', 
            type: 3, 
            required: true 
          },
          { 
            name: 'end-time', 
            description: 'Event end time (use a valid format like 5pm or 17:00)', 
            type: 3, 
            required: true 
          },
          { 
            name: 'event-type', 
            description: 'Type of event', 
            type: 3, 
            required: true,
            choices: [
              { name: EVENT_TYPES.GENERAL_MEETING, value: EVENT_TYPES.GENERAL_MEETING },
              { name: EVENT_TYPES.TECHNICAL_WORKSHOP, value: EVENT_TYPES.TECHNICAL_WORKSHOP },
              { name: EVENT_TYPES.TECH_TALK, value: EVENT_TYPES.TECH_TALK },
              { name: EVENT_TYPES.SOCIAL, value: EVENT_TYPES.SOCIAL },
            ]
          },
          { 
            name: 'event-code', 
            description: 'Unique code for event attendance', 
            type: 3, 
            required: true 
          },
        ],
      },
      {
        name: 'show-event-list',
        description: 'View recent events sorted by date. This is restricted to staff roles.',
        options: [
          { 
            name: 'number-of-events', 
            description: 'Number of recent events to display (optional, shows all if not specified)', 
            type: 4, 
            required: false 
          },
        ],
      },
      {
        name: 'get-attendance-qr',
        description: 'Get the attendance QR code. This is restricted to staff roles.',
      },
      {
        name: 'membership-logs',
        description: 'Manage logs (view or download). This is restricted to admin roles.',
        options: [
          { 
            name: 'action', 
            description: 'View or download logs', 
            type: 3, 
            required: true, 
            choices: [
              { name: 'View', value: 'view' },
              { name: 'Download', value: 'download' },
            ]
          },
          { 
            name: 'lines', 
            description: 'Number of last lines to view (only works for "View" action)', 
            type: 4, 
            required: false 
          },
          { 
            name: 'date', 
            description: 'Specify a date (YYYY-MM-DD) for previous logs', 
            type: 3, 
            required: false 
          },
        ],
      },
    ];

    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD.TOKEN);
    
    try {
      logger.info('Registering commands with Discord...');
      await rest.put(
        Routes.applicationGuildCommands(CONFIG.DISCORD.CLIENT_ID, CONFIG.DISCORD.GUILD_ID), 
        { body: commands }
      );
      logger.info('Commands registered successfully.');
    } catch (error) {
      logger.error('Error registering commands', { error: error.message });
      throw error;
    }
  }

  async start() {
    try {
      await this.registerCommands();
      await this.client.login(CONFIG.DISCORD.TOKEN);
    } catch (error) {
      logger.error('Failed to start bot', { error: error.message });
      process.exit(1);
    }
  }
}

// ============================================================================
// APPLICATION STARTUP
// ============================================================================
async function validateEnvironment() {
  const requiredVars = [
    'DISCORD_TOKEN',
    'CLIENT_ID',
    'GUILD_ID',
    'SPREADSHEET_ID',
    'CREDENTIALS_PATH'
  ];

  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    process.exit(1);
  }
}

async function main() {
  try {
    await validateEnvironment();
    
    const bot = new DiscordBot();
    await bot.start();
    
    logger.info('Bot started successfully');
  } catch (error) {
    logger.error('Application startup failed', { error: error.message });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the application
main().catch(error => {
  logger.error('Unhandled error in main', { error: error.message });
  process.exit(1);
});