import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { google } from 'googleapis';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import moment from 'moment-timezone';

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Discord bot setup and Google Sheets setup
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;
const SHEET_NAME = process.env.SHEET_NAME;
const ALLOWED_ROLES = ['membership']; // Discord roles for running commands

// ============================================================================
// CENTRALIZED COLUMN CONFIGURATION
// ============================================================================
// Define the spreadsheet columns structure here - modify this to change columns
const SHEET_COLUMNS = {
  NAME: 'Name',
  DISPLAY_NAME: 'Display_Name',
  DISCORD_USERNAME: 'Discord_Username',
  DISCORD_ID: 'Discord_ID',
  POINTS: 'Points',
  LAST_UPDATE: 'Last_Update'
};

// Define the order of columns in the spreadsheet (left to right)
const COLUMN_ORDER = [
  SHEET_COLUMNS.NAME,
  SHEET_COLUMNS.DISPLAY_NAME,
  SHEET_COLUMNS.DISCORD_USERNAME,
  SHEET_COLUMNS.DISCORD_ID,
  SHEET_COLUMNS.POINTS,
  SHEET_COLUMNS.LAST_UPDATE
];

// Helper function to get column index by name
function getColumnIndex(columnName) {
  return COLUMN_ORDER.findIndex(col => col.toLowerCase() === columnName.toLowerCase());
}

// Helper function to get the spreadsheet range based on column count
function getSheetRange() {
  const lastColumn = String.fromCharCode(65 + COLUMN_ORDER.length - 1); // A=65, B=66, etc.
  return `${SHEET_NAME}!A:${lastColumn}`;
}
// ============================================================================

// Ensure the logs directory do exist
const logsDir = path.resolve(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Initialize logger with timestamp and userId inclusion plus rotation
const logger = winston.createLogger({
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
      const options = meta.options ? ` | Options: ${JSON.stringify(meta.options)}` : '';
      const before = meta.before ? ` | Before: ${JSON.stringify(meta.before)}` : '';
      const after = meta.after ? ` | After: ${JSON.stringify(meta.after)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${executor}${target}${command}${options}${before}${after}`;
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

// Centralized logger function
function log(level, message, meta = {}) {
  logger.log(level, message, meta);
}

// Helper function to capitalize the first letter of every word
function capitalize(value) {
  return value
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Initialize Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// Authenticate with Google Sheets
async function authenticateSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Fetch all data from the sheet
async function fetchSheetData(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: getSheetRange(),
  });
  return response.data.values || [];
}

// Write updated data to the sheet
async function writeSheetData(sheets, rows) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: getSheetRange(),
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

// Generate a table image using Puppeteer with dynamic viewport size
async function generateTableImage(headers, data, fileName = 'table.png') {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 0; }
          table { border-collapse: collapse; width: auto; margin: 20px auto; font-size: 14px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          tr:nth-child(even) { background-color: #f9f9f9; }
        </style>
      </head>
      <body>
        <table>
          <thead>
            <tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${data.map((row) => `<tr>${row.map((cell) => `<td>${cell || ''}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </body>
    </html>
  `;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Load the HTML content
  await page.setContent(html);

  // Select the table and get the bounding box
  const tableHandle = await page.$('table');
  const boundingBox = await tableHandle.boundingBox();

  // Set viewport size to match the table
  const viewportHeight = boundingBox.height + 40; // Add padding for margins
  const viewportWidth = boundingBox.width + 40; // Add padding for margins
  await page.setViewport({ width: Math.ceil(viewportWidth), height: Math.ceil(viewportHeight) });

  // Take a screenshot of the table
  await page.screenshot({ path: fileName, clip: boundingBox });

  await browser.close();
}

// Register commands
const commands = [
    {
      name: 'member-update',
      description: 'Add or update member data.',
      options: [
          { name: 'name', description: 'Member name (case-insensitive).', type: 3, required: true },
          { name: 'points', description: 'Points to set for the member.', type: 4, required: false },
          { name: 'discord_id', description: 'Discord ID of the member to update. Required for allowed roles to update another member.', type: 3, required: false },
        ],
    },
    {
      name: 'member-search',
      description: 'Search for members by name or view all members.',
      options: [
        { name: 'search_for', description: 'Member name to search for, or "all" to show all members.', type: 3, required: true },
      ],
    },
    {
      name: 'member-logs',
      description: 'Manage logs (view, download or clear). This is restricted.',
      options: [
          { name: 'action', description: 'View, download, or clear logs', type: 3, required: true, choices: [
              { name: 'View', value: 'view' },
              { name: 'Download', value: 'download' },
              { name: 'Clear', value: 'clear' },
          ] },
          { name: 'lines', description: 'Number of last lines to view (only works for "View" action)', type: 4, required: false },
          { name: 'date', description: 'Specify a date (YYYY-MM-DD) for previous logs', type: 3, required: false },
      ],
  },
  ];

(async () => {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    logger.info('Registering commands in discord...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    logger.info('Commands registered successfully.');
  } catch (error) {
    logger.error('Error registering commands:', error);
  }
})();

// Handle commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, options } = interaction;

  try {
    const sheets = await authenticateSheets();
    const rows = await fetchSheetData(sheets);
    
    // Ensure we have headers, if not create them
    if (rows.length === 0) {
      rows.push(COLUMN_ORDER);
    }
    
    const headers = rows[0];

    // Handle member-update command
    if (commandName === 'member-update') {
      try {
        const memberName = capitalize(options.getString('name'));
        const userDiscordId = interaction.user.id;
        const userDisplayName = interaction.member.displayName;
        const userDiscordUsername = interaction.user.username;
        const discordIdOption = options.getString('discord_id');
        const pointsValue = options.getInteger('points');
        const timestamp = moment().tz('America/Chicago').format('YYYY-MM-DD HH:mm:ss');
        
        // Check if the user has allowed roles
        const isAllowedRole = ALLOWED_ROLES.some((role) => interaction.member.roles.cache.some((r) => r.name === role));

        // If discord_id is provided and user has allowed role, update another member
        if (discordIdOption && isAllowedRole) {
          const targetRowIndex = rows.findIndex((row, index) => 
            index > 0 && row[getColumnIndex(SHEET_COLUMNS.DISCORD_ID)] === discordIdOption
          );

          if (targetRowIndex === -1) {
            log('warn', `[UPDATE FAILED] Discord ID not found`, {
              executor: { discord_id: userDiscordId, username: userDiscordUsername, display_name: interaction.user.tag, userDisplayName },
              target: { discord_id: discordIdOption },
              command: { name: commandName },
              options: { name: memberName, points: pointsValue },
            });
            await interaction.reply(`No member found with Discord ID: ${discordIdOption}`);
            return;
          }
          
          // Track changes for logging
          const beforeState = {};
          const afterState = {};
          
          // Update name if provided
          const nameIndex = getColumnIndex(SHEET_COLUMNS.NAME);
          if (rows[targetRowIndex][nameIndex] !== memberName) {
            beforeState.name = rows[targetRowIndex][nameIndex];
            afterState.name = memberName;
            rows[targetRondex][nameIndex] = memberName;
          }
          
          // Update points if provided
          if (pointsValue !== null) {
            const pointsIndex = getColumnIndex(SHEET_COLUMNS.POINTS);
            const currentPoints = rows[targetRowIndex][pointsIndex];
            if (currentPoints !== pointsValue.toString()) {
              beforeState.points = currentPoints;
              afterState.points = pointsValue.toString();
              rows[targetRowIndex][pointsIndex] = pointsValue.toString();
            }
          }

          // Update last_update timestamp
          rows[targetRowIndex][getColumnIndex(SHEET_COLUMNS.LAST_UPDATE)] = timestamp;

          log('info', `[UPDATE SUCCESS] Data updated by allowed role`, {
            executor: { userDisplayName, discord_id: userDiscordId, username: userDiscordUsername },
            target: { name: memberName, discord_id: discordIdOption },
            command: { name: commandName },
            options: { name: memberName, points: pointsValue },
            before: beforeState,
            after: afterState,
          });

          await interaction.reply(`Updated data for member: ${memberName}, by: ${userDisplayName}`);
        } else {
          // Update own data or create new entry
          const existingRowIndex = rows.findIndex((row, index) => 
            index > 0 && row[getColumnIndex(SHEET_COLUMNS.NAME)]?.toLowerCase() === memberName.toLowerCase()
          );

          if (existingRowIndex === -1) {
            // Create new member entry
            const newRow = Array(COLUMN_ORDER.length).fill('');
            newRow[getColumnIndex(SHEET_COLUMNS.NAME)] = memberName;
            newRow[getColumnIndex(SHEET_COLUMNS.DISPLAY_NAME)] = userDisplayName;
            newRow[getColumnIndex(SHEET_COLUMNS.DISCORD_USERNAME)] = userDiscordUsername;
            newRow[getColumnIndex(SHEET_COLUMNS.DISCORD_ID)] = userDiscordId;
            newRow[getColumnIndex(SHEET_COLUMNS.POINTS)] = pointsValue ? pointsValue.toString() : '0';
            newRow[getColumnIndex(SHEET_COLUMNS.LAST_UPDATE)] = timestamp;

            rows.push(newRow);

            log('info', `[ADD SUCCESS] New member added`, {
              executor: { discord_id: userDiscordId, username: userDiscordUsername, display_name: interaction.user.tag, userDisplayName },
              target: { name: memberName, discord_id: userDiscordId },
              command: { name: commandName },
              options: { name: memberName, points: pointsValue },
            });

            await interaction.reply(`Added new member: ${memberName}`);
          } else {
            // Update existing member - check if it's the same user
            const currentDiscordId = rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.DISCORD_ID)];
            const currentName = rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.NAME)];

            if (currentDiscordId === userDiscordId) {
              // User is updating their own data
              const beforeState = {};
              const afterState = {};

              // Update display name and username
              rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.DISPLAY_NAME)] = userDisplayName;
              rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.DISCORD_USERNAME)] = userDiscordUsername;
              
              // Update points if provided
              if (pointsValue !== null) {
                const pointsIndex = getColumnIndex(SHEET_COLUMNS.POINTS);
                const currentPoints = rows[existingRowIndex][pointsIndex];
                if (currentPoints !== pointsValue.toString()) {
                  beforeState.points = currentPoints;
                  afterState.points = pointsValue.toString();
                  rows[existingRowIndex][pointsIndex] = pointsValue.toString();
                }
              }

              // Update timestamp
              rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.LAST_UPDATE)] = timestamp;

              log('info', `[UPDATE SUCCESS] Member updated own data`, {
                executor: { discord_id: userDiscordId, username: userDiscordUsername, display_name: interaction.user.tag, userDisplayName },
                target: { name: currentName, discord_id: currentDiscordId },
                command: { name: commandName },
                options: { name: memberName, points: pointsValue },
                before: beforeState,
                after: afterState,
              });

              await interaction.reply(`Updated data for: ${currentName}`);
            } else {
              // User trying to update someone else's data without permission
              log('warn', `[UPDATE FAILED] Unauthorized update attempt`, {
                executor: { discord_id: userDiscordId, username: userDiscordUsername, display_name: interaction.user.tag, userDisplayName },
                target: { name: currentName, discord_id: currentDiscordId },
                command: { name: commandName },
                options: { name: memberName, points: pointsValue },
              });
              await interaction.reply('You do not have permission to update this member\'s data.');
              return;
            }
          }
        }

        await writeSheetData(sheets, rows);
      } catch (error) {
        log('error', 'Error handling member-update command', {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName: interaction.member?.displayName },
          error: error.message,
        });
        await interaction.reply('An error occurred while processing your update command.');
      }
    }

    // Handle member-search command
    if (commandName === 'member-search') {
      try {
        const searchFor = options.getString('search_for').toLowerCase();
        const userDisplayName = interaction.member.displayName;

        let filteredRows;
        
        if (searchFor === 'all') {
          // Show all members (excluding header row)
          filteredRows = rows.slice(1);
        } else {
          // Search for specific member by name
          filteredRows = rows.slice(1).filter((row) => 
            row[getColumnIndex(SHEET_COLUMNS.NAME)]?.toLowerCase().includes(searchFor)
          );
        }

        if (filteredRows.length === 0) {
          log('info', `[SEARCH EMPTY] No results found`, {
            executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
            command: { name: commandName },
            options: { search_for: searchFor },
          });
          await interaction.reply(`No members found matching: ${searchFor}`);
          return;
        }

        // Generate and send the table image
        const fileName = 'members_table.png';
        await generateTableImage(headers, filteredRows, fileName);
        
        log('info', `[SEARCH SUCCESS] Results found`, {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
          command: { name: commandName },
          options: { search_for: searchFor },
          results: { count: filteredRows.length },
        });
        
        const resultText = searchFor === 'all' ? 'All members:' : `Search results for "${searchFor}":`;
        await interaction.reply({ content: resultText, files: [fileName] });
        fs.unlinkSync(fileName);
      } catch (error) {
        log('error', 'Error handling member-search command', {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName: interaction.member?.displayName },
          error: error.message,
        });
        await interaction.reply('An error occurred while processing your search command.');
      }
    }
 
  } catch (error) {
    log('error', 'Error handling command', {
      executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag },
      error: error.message,
    });
    await interaction.reply('An error occurred while processing your command.');
  }
});

// Handle member-logs command
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, options } = interaction;

  if (commandName === 'member-logs') {
    try {
      const action = options.getString('action');
      const lines = options.getInteger('lines') || 10;
      const date = options.getString('date') || moment().format('YYYY-MM-DD');
      const memberRoles = interaction.member.roles.cache.map((role) => role.name);
      const userDisplayName = interaction.member.displayName;

      if (!ALLOWED_ROLES.some((role) => memberRoles.includes(role))) {
        log('warn', `[LOGS FAILED] Unauthorized access attempt`, {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
          command: { name: commandName },
          options: { action, lines, date },
        });
        await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        return;
      }

      const logFilePath = path.resolve(__dirname, `logs/bot-${date}.log`);

      if (action === 'view') {
        if (!fs.existsSync(logFilePath)) {
          log('warn', `[LOGS VIEW FAILED] File not found`, {
            executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
            command: { name: commandName },
            options: { action, lines, date },
          });
          await interaction.reply({ content: `No log file found for the specified date: ${date}.`, ephemeral: true });
          return;
        }

        const logData = fs.readFileSync(logFilePath, 'utf8').split('\n').slice(-lines).join('\n');
        const content = `\`\`\`log\n${logData}\n\`\`\``;

        if (content.length > 2000) {
          await interaction.reply({ content: 'Log data is too large to display. Use the "Download" option.', ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }

        log('info', `[LOGS VIEW SUCCESS] Logs viewed`, {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
          command: { name: commandName },
          options: { action, lines, date },
        });
      } else if (action === 'download') {
        if (!fs.existsSync(logFilePath)) {
          log('warn', `[LOGS DOWNLOAD FAILED] File not found`, {
            executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
            command: { name: commandName },
            options: { action, date },
          });
          await interaction.reply({ content: `No log file found for the specified date: ${date}.`, ephemeral: true });
          return;
        }

        await interaction.reply({ content: `Here are the logs for ${date}:`, files: [logFilePath], ephemeral: true });

        log('info', `[LOGS DOWNLOAD SUCCESS] Logs downloaded`, {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
          command: { name: commandName },
          options: { action, date },
        });
      } else if (action === 'clear') {
        if (fs.existsSync(logFilePath)) {
          fs.writeFileSync(logFilePath, '');
          await interaction.reply({ content: `The logs for ${date} have been cleared successfully.`, ephemeral: true });

          log('info', `[LOGS CLEAR SUCCESS] Logs cleared`, {
            executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
            command: { name: commandName },
            options: { action, date },
          });
        } else {
          log('warn', `[LOGS CLEAR FAILED] File not found`, {
            executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
            command: { name: commandName },
            options: { action, date },
          });
          await interaction.reply({ content: `No log file found for the specified date: ${date}.`, ephemeral: true });
        }
      }
    } catch (error) {
      log('error', 'Error handling member-logs command', {
        executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName: interaction.member?.displayName },
        error: error.message,
      });
      await interaction.reply({ content: 'An error occurred while processing your logs command.', ephemeral: true });
    }
  }
});

client.on('ready', () => {
  logger.info(`Bot logged in as ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);