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
  DISPLAY_NAME: 'Display Name',
  DISCORD_USERNAME: 'Discord Username',
  DISCORD_ID: 'Discord ID',
  POINTS: 'Points',
  LAST_UPDATE: 'Last Update',
  ANONYMOUS: 'Anonymous?'
};

// Define the order of columns in the spreadsheet (left to right)
const COLUMN_ORDER = [
  SHEET_COLUMNS.NAME,
  SHEET_COLUMNS.ANONYMOUS,
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

function getExecutorUsername(interaction) {
  return interaction.member?.displayName || interaction.user?.username || "Unknown";
}

function checkPermissions(interaction) {
  const memberRoles = interaction.member?.roles?.cache?.map((role) => role.name) || [];
  return CONFIG.DISCORD.ALLOWED_ROLES.some((role) => memberRoles.includes(role));
}

function isAnonymous(anonymousValue) {
  if (!anonymousValue || typeof anonymousValue !== 'string') return true;
  const value = anonymousValue.toLowerCase().trim();
  return !(value === 'false' || value === 'no');
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
          const results = meta.results ? ` | Results: ${JSON.stringify(meta.results)}` : '';
          return `${timestamp} [${level.toUpperCase()}] ${message}${executor}${target}${command}${options}${before}${after}${results}`;
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
// COMMAND HANDLERS
// ============================================================================
class CommandHandlers {
  constructor(sheetsService) {
    this.sheetsService = sheetsService;
  }

  async handleViewLeaderboard(interaction) {
    try {
      const userDisplayName = getExecutorUsername(interaction);
      
      // Check permissions
      if (!checkPermissions(interaction)) {
        logger.warn('[LEADERBOARD FAILED] Unauthorized access attempt', {
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

      const rows = await this.sheetsService.fetchSheetData();
      
      if (rows.length <= 1) {
        logger.info('[LEADERBOARD EMPTY] No data found', {
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
      const nameIndex = getColumnIndex(SHEET_COLUMNS.NAME);
      const pointsIndex = getColumnIndex(SHEET_COLUMNS.POINTS);
      const anonymousIndex = getColumnIndex(SHEET_COLUMNS.ANONYMOUS);

      // Process and sort data by points (descending)
      const processedData = rows.slice(1)
        .filter(row => row[pointsIndex] && !isNaN(row[pointsIndex])) // Only rows with valid points
        .map(row => ({
          name: isAnonymous(row[anonymousIndex]) ? 'Anonymous' : (row[nameIndex] || 'Unknown'),
          points: parseInt(row[pointsIndex]) || 0,
          originalName: row[nameIndex] || 'Unknown'
        }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 15); // Top 15

      if (processedData.length === 0) {
        logger.info('[LEADERBOARD EMPTY / INVALID] No valid data found', {
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

      const fileName = 'leaderboard.png';
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
      // await TableImageGenerator.generateLeaderboardImage(processedData, fileName);
      
      logger.info('[LEADERBOARD SUCCESS] Leaderboard generated', {
        executor: { 
          discord_id: interaction.user.id, 
          username: interaction.user.username, 
          userDisplayName 
        },
        command: { name: 'view-leaderboard' },
        results: { count: processedData.length },
      });
      
      // await interaction.reply({ content: '🏆 **Current Leaderboard - Top 15** 🏆', files: [fileName] });
      
      // // Clean up the generated file
      // if (fs.existsSync(fileName)) {
      //   fs.unlinkSync(fileName);
      // }
    } catch (error) {
      logger.error('Error handling view-leaderboard command', {
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
    try {
      const action = interaction.options.getString('action');
      const lines = interaction.options.getInteger('lines') || 10;
      const date = interaction.options.getString('date') || moment().format('YYYY-MM-DD');
      const userDisplayName = getExecutorUsername(interaction);

      // Check permissions
      if (!checkPermissions(interaction)) {
        logger.warn('[LOGS FAILED] Unauthorized access attempt', {
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
          await this.handleLogView(interaction, logFilePath, lines, date, userDisplayName);
          break;
        case 'download':
          await this.handleLogDownload(interaction, logFilePath, date, userDisplayName);
          break;
      }
    } catch (error) {
      logger.error('Error handling membership-logs command', {
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

  async handleLogView(interaction, logFilePath, lines, date, userDisplayName) {
    if (!fs.existsSync(logFilePath)) {
      logger.warn('[LOGS VIEW FAILED] File not found', {
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
      executor: { 
        discord_id: interaction.user.id, 
        username: interaction.user.username, 
        userDisplayName 
      },
      command: { name: 'membership-logs' },
      options: { action: 'view', lines, date },
    });
  }

  async handleLogDownload(interaction, logFilePath, date, userDisplayName) {
    if (!fs.existsSync(logFilePath)) {
      logger.warn('[LOGS DOWNLOAD FAILED] File not found', {
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
      executor: { 
        discord_id: interaction.user.id, 
        username: interaction.user.username, 
        userDisplayName 
      },
      command: { name: 'membership-logs' },
      options: { action: 'download', date },
    });
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
        name: 'membership-logs',
        description: 'Manage logs (view or download). This is restricted to authorized roles.',
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