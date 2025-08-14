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

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
  DISCORD: {
    TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID,
    GUILD_ID: process.env.GUILD_ID,
    ALLOWED_ROLES: ['membership']
  },
  GOOGLE_SHEETS: {
    SPREADSHEET_ID: process.env.SPREADSHEET_ID,
    CREDENTIALS_PATH: process.env.CREDENTIALS_PATH,
    SHEET_NAME: process.env.SHEET_NAME
  },
  TIMEZONE: 'America/Chicago'
};

// Define the spreadsheet columns structure - modify this to change columns
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

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function getColumnIndex(columnName) {
  return COLUMN_ORDER.findIndex(col => col.toLowerCase() === columnName.toLowerCase());
}

function getSheetRange() {
  const lastColumn = String.fromCharCode(65 + COLUMN_ORDER.length - 1);
  return `${CONFIG.GOOGLE_SHEETS.SHEET_NAME}!A:${lastColumn}`;
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

  async fetchSheetData() {
    try {
      if (!this.sheets) await this.authenticate();
      
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.GOOGLE_SHEETS.SPREADSHEET_ID,
        range: getSheetRange(),
      });

      const data = response.data.values || [];
      
      // Ensure we have headers, if not create them
      if (data.length === 0) {
        data.push(COLUMN_ORDER);
      }
      
      return data;
    } catch (error) {
      logger.error('Failed to fetch sheet data', { error: error.message });
      throw error;
    }
  }

  async writeSheetData(rows) {
    try {
      if (!this.sheets) await this.authenticate();
      
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.GOOGLE_SHEETS.SPREADSHEET_ID,
        range: getSheetRange(),
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      });
      
      logger.info('Sheet data updated successfully');
    } catch (error) {
      logger.error('Failed to write sheet data', { error: error.message });
      throw error;
    }
  }
}

// ============================================================================
// TABLE IMAGE GENERATOR
// ============================================================================
class TableImageGenerator {
  static async generateImage(headers, data, fileName = 'table.png') {
    // Format the data for better display
    const formattedData = data.map(row => {
      return row.map((cell, index) => {
        // Add commas to numbers in the Points column
        if (headers[index] === 'Points' && !isNaN(cell)) {
          return Number(cell).toLocaleString();
        }
        // Format timestamps in Last_Update column
        if (headers[index] === 'Last_Update' && cell) {
          return moment(cell).format('MM/DD/YY HH:mm');
        }
        return cell || '';
      });
    });

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
              margin: 0;
              padding: 20px;
              background-color: #f8f9fa;
            }
            .container {
              background-color: white;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
              padding: 20px;
              margin: 0 auto;
            }
            table {
              border-collapse: separate;
              border-spacing: 0;
              width: 100%;
              margin: 0 auto;
              font-size: 14px;
              border-radius: 8px;
              overflow: hidden;
            }
            th, td {
              padding: 12px 15px;
              text-align: left;
              border-bottom: 1px solid #e9ecef;
            }
            th {
              background-color: #4682b4;
              color: white;
              font-weight: 600;
              white-space: nowrap;
            }
            tr:last-child td {
              border-bottom: none;
            }
            tr:nth-child(even) {
              background-color: #f8f9fa;
            }
            tr:hover {
              background-color: #f2f4f6;
            }
            td {
              color: #333;
            }
            .row-number {
              color: #666;
              font-size: 12px;
              text-align: center;
              width: 40px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <table>
              <thead>
                <tr>
                  <th class="row-number">#</th>
                  ${headers.map(header => `<th>${header.replace('_', ' ')}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${formattedData.map((row, index) => `
                  <tr>
                    <td class="row-number">${index + 1}</td>
                    ${row.map(cell => `<td>${cell}</td>`).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </body>
      </html>
    `;

    let browser;
    try {
      browser = await puppeteer.launch({ 
        headless: 'new', 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
      });
      const page = await browser.newPage();

      await page.setContent(html);
      
      // Set viewport to a large size initially to ensure content fits
      await page.setViewport({ width: 1200, height: 800 });
      
      // Get the container element that wraps the table
      const containerHandle = await page.$('.container');
      const boundingBox = await containerHandle.boundingBox();
      
      // Add padding to the screenshot dimensions
      const padding = 40;
      await page.setViewport({ 
        width: Math.ceil(boundingBox.width + padding * 2), 
        height: Math.ceil(boundingBox.height + padding * 2)
      });

      // Take screenshot of the container with padding
      await page.screenshot({ 
        path: fileName,
        clip: {
          x: boundingBox.x - padding,
          y: boundingBox.y - padding,
          width: boundingBox.width + padding * 2,
          height: boundingBox.height + padding * 2
        }
      });
      
      logger.info('Table image generated successfully', { fileName });
    } catch (error) {
      logger.error('Failed to generate table image', { error: error.message, fileName });
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
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

  async handleMemberUpdate(interaction) {
    try {
      const memberName = capitalize(interaction.options.getString('name'));
      const userDiscordId = interaction.user.id;
      const userDisplayName = interaction.member.displayName;
      const userDiscordUsername = interaction.user.username;
      const discordIdOption = interaction.options.getString('discord_id');
      const pointsValue = interaction.options.getInteger('points');
      const timestamp = getCurrentTimestamp();
      
      const isAllowedRole = CONFIG.DISCORD.ALLOWED_ROLES.some((role) => 
        interaction.member.roles.cache.some((r) => r.name === role)
      );

      const rows = await this.sheetsService.fetchSheetData();
      
      // Handle updating another member (requires allowed role)
      if (discordIdOption && isAllowedRole) {
        await this.updateOtherMember(interaction, rows, {
          memberName, userDiscordId, userDisplayName, userDiscordUsername,
          discordIdOption, pointsValue, timestamp
        });
      } else {
        // Handle self-update or new member creation
        await this.updateSelfOrCreate(interaction, rows, {
          memberName, userDiscordId, userDisplayName, userDiscordUsername,
          pointsValue, timestamp
        });
      }

      await this.sheetsService.writeSheetData(rows);
    } catch (error) {
      logger.error('Error handling member-update command', {
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: interaction.member?.displayName 
        },
        error: error.message,
      });
      await interaction.reply('An error occurred while processing your update command.');
    }
  }

  async updateOtherMember(interaction, rows, params) {
    const { memberName, userDiscordId, userDisplayName, userDiscordUsername,
            discordIdOption, pointsValue, timestamp } = params;
    
    const targetRowIndex = rows.findIndex((row, index) => 
      index > 0 && row[getColumnIndex(SHEET_COLUMNS.DISCORD_ID)] === discordIdOption
    );

    if (targetRowIndex === -1) {
      logger.warn('[UPDATE FAILED] Discord ID not found', {
        executor: { discord_id: userDiscordId, username: userDiscordUsername, userDisplayName },
        target: { discord_id: discordIdOption },
        command: { name: 'member-update' },
        options: { name: memberName, points: pointsValue },
      });
      await interaction.reply(`No member found with Discord ID: ${discordIdOption}`);
      return;
    }
    
    const beforeState = {};
    const afterState = {};
    
    // Update name
    const nameIndex = getColumnIndex(SHEET_COLUMNS.NAME);
    if (rows[targetRowIndex][nameIndex] !== memberName) {
      beforeState.name = rows[targetRowIndex][nameIndex];
      afterState.name = memberName;
      rows[targetRowIndex][nameIndex] = memberName;
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

    rows[targetRowIndex][getColumnIndex(SHEET_COLUMNS.LAST_UPDATE)] = timestamp;

    logger.info('[UPDATE SUCCESS] Data updated by allowed role', {
      executor: { userDisplayName, discord_id: userDiscordId, username: userDiscordUsername },
      target: { name: memberName, discord_id: discordIdOption },
      command: { name: 'member-update' },
      options: { name: memberName, points: pointsValue },
      before: beforeState,
      after: afterState,
    });

    await interaction.reply(`Updated data for member: ${memberName}, by: ${userDisplayName}`);
  }

  async updateSelfOrCreate(interaction, rows, params) {
    const { memberName, userDiscordId, userDisplayName, userDiscordUsername,
            pointsValue, timestamp } = params;
    
    const existingRowIndex = rows.findIndex((row, index) => 
      index > 0 && row[getColumnIndex(SHEET_COLUMNS.NAME)]?.toLowerCase() === memberName.toLowerCase()
    );

    if (existingRowIndex === -1) {
      // Create new member
      const newRow = Array(COLUMN_ORDER.length).fill('');
      newRow[getColumnIndex(SHEET_COLUMNS.NAME)] = memberName;
      newRow[getColumnIndex(SHEET_COLUMNS.DISPLAY_NAME)] = userDisplayName;
      newRow[getColumnIndex(SHEET_COLUMNS.DISCORD_USERNAME)] = userDiscordUsername;
      newRow[getColumnIndex(SHEET_COLUMNS.DISCORD_ID)] = userDiscordId;
      newRow[getColumnIndex(SHEET_COLUMNS.POINTS)] = pointsValue ? pointsValue.toString() : '0';
      newRow[getColumnIndex(SHEET_COLUMNS.LAST_UPDATE)] = timestamp;

      rows.push(newRow);

      logger.info('[ADD SUCCESS] New member added', {
        executor: { discord_id: userDiscordId, username: userDiscordUsername, userDisplayName },
        target: { name: memberName, discord_id: userDiscordId },
        command: { name: 'member-update' },
        options: { name: memberName, points: pointsValue },
      });

      await interaction.reply(`Added new member: ${memberName}`);
    } else {
      // Update existing member
      const currentDiscordId = rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.DISCORD_ID)];
      const currentName = rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.NAME)];

      if (currentDiscordId === userDiscordId) {
        const beforeState = {};
        const afterState = {};

        rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.DISPLAY_NAME)] = userDisplayName;
        rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.DISCORD_USERNAME)] = userDiscordUsername;
        
        if (pointsValue !== null) {
          const pointsIndex = getColumnIndex(SHEET_COLUMNS.POINTS);
          const currentPoints = rows[existingRowIndex][pointsIndex];
          if (currentPoints !== pointsValue.toString()) {
            beforeState.points = currentPoints;
            afterState.points = pointsValue.toString();
            rows[existingRowIndex][pointsIndex] = pointsValue.toString();
          }
        }

        rows[existingRowIndex][getColumnIndex(SHEET_COLUMNS.LAST_UPDATE)] = timestamp;

        logger.info('[UPDATE SUCCESS] Member updated own data', {
          executor: { discord_id: userDiscordId, username: userDiscordUsername, userDisplayName },
          target: { name: currentName, discord_id: currentDiscordId },
          command: { name: 'member-update' },
          options: { name: memberName, points: pointsValue },
          before: beforeState,
          after: afterState,
        });

        await interaction.reply(`Updated data for: ${currentName}`);
      } else {
        logger.warn('[UPDATE FAILED] Unauthorized update attempt', {
          executor: { discord_id: userDiscordId, username: userDiscordUsername, userDisplayName },
          target: { name: currentName, discord_id: currentDiscordId },
          command: { name: 'member-update' },
          options: { name: memberName, points: pointsValue },
        });
        await interaction.reply('You do not have permission to update this member\'s data.');
      }
    }
  }

  async handleMemberSearch(interaction) {
    try {
      const searchFor = interaction.options.getString('search_for').toLowerCase();
      const userDisplayName = interaction.member.displayName;
      const rows = await this.sheetsService.fetchSheetData();
      const headers = rows[0];

      let filteredRows;
      
      if (searchFor === 'all') {
        filteredRows = rows.slice(1);
      } else {
        filteredRows = rows.slice(1).filter((row) => 
          row[getColumnIndex(SHEET_COLUMNS.NAME)]?.toLowerCase().includes(searchFor)
        );
      }

      if (filteredRows.length === 0) {
        logger.info('[SEARCH EMPTY] No results found', {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, userDisplayName },
          command: { name: 'member-search' },
          options: { search_for: searchFor },
        });
        await interaction.reply(`No members found matching: ${searchFor}`);
        return;
      }

      const fileName = 'members_table.png';
      await TableImageGenerator.generateImage(headers, filteredRows, fileName);
      
      logger.info('[SEARCH SUCCESS] Results found', {
        executor: { discord_id: interaction.user.id, username: interaction.user.username, userDisplayName },
        command: { name: 'member-search' },
        options: { search_for: searchFor },
        results: { count: filteredRows.length },
      });
      
      const resultText = searchFor === 'all' ? 'All members:' : `Search results for "${searchFor}":`;
      await interaction.reply({ content: resultText, files: [fileName] });
      
      // Clean up the generated file
      if (fs.existsSync(fileName)) {
        fs.unlinkSync(fileName);
      }
    } catch (error) {
      logger.error('Error handling member-search command', {
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: interaction.member?.displayName 
        },
        error: error.message,
      });
      await interaction.reply('An error occurred while processing your search command.');
    }
  }

  async handleMemberLogs(interaction) {
    try {
      const action = interaction.options.getString('action');
      const lines = interaction.options.getInteger('lines') || 10;
      const date = interaction.options.getString('date') || moment().format('YYYY-MM-DD');
      const memberRoles = interaction.member.roles.cache.map((role) => role.name);
      const userDisplayName = interaction.member.displayName;

      if (!CONFIG.DISCORD.ALLOWED_ROLES.some((role) => memberRoles.includes(role))) {
        logger.warn('[LOGS FAILED] Unauthorized access attempt', {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, userDisplayName },
          command: { name: 'member-logs' },
          options: { action, lines, date },
        });
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: ['Ephemeral'] });
        return;
      }

      const logFilePath = path.resolve(__dirname, `logs/bot-${date}.log`);

      switch (action) {
        case 'view':
          await this.handleLogView(interaction, logFilePath, lines, date);
          break;
        case 'download':
          await this.handleLogDownload(interaction, logFilePath, date);
          break;
        case 'clear':
          await this.handleLogClear(interaction, logFilePath, date);
          break;
      }
    } catch (error) {
      logger.error('Error handling member-logs command', {
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username,
          userDisplayName: interaction.member?.displayName 
        },
        error: error.message,
      });
      await interaction.reply({ content: 'An error occurred while processing your logs command.', ephemeral: true });
    }
  }

  async handleLogView(interaction, logFilePath, lines, date) {
    if (!fs.existsSync(logFilePath)) {
      logger.warn('[LOGS VIEW FAILED] File not found', {
        executor: { discord_id: interaction.user.id, username: interaction.user.username },
        options: { action: 'view', lines, date },
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

    logger.info('[LOGS VIEW SUCCESS] Logs viewed', {
      executor: { discord_id: interaction.user.id, username: interaction.user.username },
      options: { action: 'view', lines, date },
    });
  }

  async handleLogDownload(interaction, logFilePath, date) {
    if (!fs.existsSync(logFilePath)) {
      logger.warn('[LOGS DOWNLOAD FAILED] File not found', {
        executor: { discord_id: interaction.user.id, username: interaction.user.username },
        options: { action: 'download', date },
      });
      await interaction.reply({ content: `No log file found for the specified date: ${date}.`, ephemeral: true });
      return;
    }

    await interaction.reply({ content: `Here are the logs for ${date}:`, files: [logFilePath], ephemeral: true });

    logger.info('[LOGS DOWNLOAD SUCCESS] Logs downloaded', {
      executor: { discord_id: interaction.user.id, username: interaction.user.username },
      options: { action: 'download', date },
    });
  }

  async handleLogClear(interaction, logFilePath, date) {
    if (fs.existsSync(logFilePath)) {
      fs.writeFileSync(logFilePath, '');
      await interaction.reply({ content: `The logs for ${date} have been cleared successfully.`, ephemeral: true });

      logger.info('[LOGS CLEAR SUCCESS] Logs cleared', {
        executor: { discord_id: interaction.user.id, username: interaction.user.username },
        options: { action: 'clear', date },
      });
    } else {
      logger.warn('[LOGS CLEAR FAILED] File not found', {
        executor: { discord_id: interaction.user.id, username: interaction.user.username },
        options: { action: 'clear', date },
      });
      await interaction.reply({ content: `No log file found for the specified date: ${date}.`, ephemeral: true });
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
    this.client.once('ready', () => {
      logger.info(`Bot logged in as ${this.client.user.tag}`);
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isCommand()) return;

      const { commandName } = interaction;

      try {
        switch (commandName) {
          case 'member-update':
            await this.commandHandlers.handleMemberUpdate(interaction);
            break;
          case 'member-search':
            await this.commandHandlers.handleMemberSearch(interaction);
            break;
          case 'member-logs':
            await this.commandHandlers.handleMemberLogs(interaction);
            break;
          default:
            logger.warn('Unknown command received', { commandName });
            await interaction.reply('Unknown command.');
        }
      } catch (error) {
        logger.error('Error handling interaction', {
          commandName,
          error: error.message,
          executor: { discord_id: interaction.user.id, username: interaction.user.username }
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
          ]},
          { name: 'lines', description: 'Number of last lines to view (only works for "View" action)', type: 4, required: false },
          { name: 'date', description: 'Specify a date (YYYY-MM-DD) for previous logs', type: 3, required: false },
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
    'CREDENTIALS_PATH',
    'SHEET_NAME'
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