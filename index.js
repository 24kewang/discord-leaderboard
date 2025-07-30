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
    range: `${SHEET_NAME}!A:N`,
  });
  return response.data.values || [];
}

// Write updated data to the sheet
async function writeSheetData(sheets, rows) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:N`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

// Generate a table image using Puppeteer with dynamic viewport size
async function generateTableImage(headers, data, fileName = 'table.png') {
  // Limit headers and data to the first 12 columns
  const limitedHeaders = headers.slice(0, 12);
  const limitedData = data.map((row) => row.slice(0, 12));

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
            <tr>${limitedHeaders.map((header) => `<th>${header}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${limitedData.map((row) => `<tr>${row.map((cell) => `<td>${cell || ''}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </body>
    </html>
  `;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Load the HTML content
  await page.setContent(html);

  // Select the table and get the bounding box for the first 12 columns
  const tableHandle = await page.$('table');
  const boundingBox = await tableHandle.boundingBox();

  // Calculate column widths based on the table's bounding box
  const columnWidth = boundingBox.width / headers.length;
  const viewportWidth = columnWidth * limitedHeaders.length;

  // Set viewport size to exactly match the first 12 columns
  const viewportHeight = boundingBox.height + 40; // Add padding for margins
  await page.setViewport({ width: Math.ceil(viewportWidth), height: Math.ceil(viewportHeight) });

  // Take a screenshot of the adjusted viewport
  await page.screenshot({ path: fileName, clip: boundingBox });

  await browser.close();
}

// Register commands
const commands = [
    {
      name: 'artisan-update',
      description: 'Add or update data for a Member.',
      options: [
          { name: 'name', description: 'Update or add data for a specific Member Name,(case-insensitive).', type: 3, required: true },
          { name: 'profession_1', description: 'Your First Profession 1.', type: 3, required: false },
          { name: 'level_1', description: 'Level of your Profession 1, (e.g., Grandmaster / Master / Journeyman / Apprentice).', type: 3, required: false },
          { name: 'profession_2', description: 'Your Second Profession 2.', type: 3, required: false },
          { name: 'level_2', description: 'Level of your Profession 2, (e.g., Grandmaster / Master / Journeyman / Apprentice)..', type: 3, required: false },
          { name: 'profession_3', description: 'Your Third Profession 3.', type: 3, required: false },
          { name: 'level_3', description: 'Level of your Profession 3, (e.g., Grandmaster / Master / Journeyman / Apprentice)..', type: 3, required: false },
          { name: 'profession_4', description: 'Your Fourth Profession 4.', type: 3, required: false },
          { name: 'level_4', description: 'Level of your Profession 4, (e.g., Grandmaster / Master / Journeyman / Apprentice)..', type: 3, required: false },
          { name: 'profession_5', description: 'Your Fifth Profession 5.', type: 3, required: false },
          { name: 'level_5', description: 'Level of your Profession 5, (e.g., Grandmaster / Master / Journeyman / Apprentice)..', type: 3, required: false },
          { name: 'discord_id', description: 'Discord ID of the member to update. Required for allowed roles to update another member.', type: 3, required: false },
        ],
    },
    {
      name: 'artisan-search',
      description: 'Search Professions for a Member or an expertise of a Profession.',
      options: [
        { name: 'search_for', description: 'Member or Professions to search.', type: 3, required: true },
        { name: 'columns', description: '"Any" to search all, or Profession_1, Profession_2, Profession_3, Profession_4, Profession_5', type: 3, required: true },
        { name: 'level', description: 'Filter results by profession level', type: 3, required: false },
      ],
    },
    {
      name: 'artisan-logs',
      description: 'Manage logs (view, download or clear), This is restricted.',
      options: [
          { name: 'action', description: 'View, download, or clear logs', type: 3, required: true, choices: [
              { name: 'View', value: 'view' },
              { name: 'Download', value: 'download' },
              { name: 'Clear', value: 'clear' },
          ] },
          { name: 'lines', description: 'Number of last lines to view (this only work for "View" action)', type: 4, required: false },
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
    const headers = rows[0];

    const validColumns = headers.slice(0, 14);
    const validColumnsearch = headers.slice(0, 12);
    const restrictedRows = rows.map((row) => row.slice(0, 14));

// Inside artisan-update command handler
if (commandName === 'artisan-update') {
  try {
    const userId = capitalize(options.getString('name'));
    const userDiscordId = interaction.user.id;
    const userDisplayName = interaction.member.displayName;
    const discordIdOption = options.getString('discord_id');
    const updates = {};

    // Extract updates from command options
    ['profession_1', 'level_1', 'profession_2', 'level_2', 'profession_3', 'level_3', 'profession_4', 'level_4', 'profession_5', 'level_5'].forEach((option) => {
      const value = options.getString(option);
      if (value) updates[option] = capitalize(value);
    });

    const timestamp = moment().tz('America/Chicago').format('YYYY-MM-DD HH:mm:ss'); // Get current timestamp in CST
    
    // Check if the user has allowed roles
    const isAllowedRole = ALLOWED_ROLES.some((role) => interaction.member.roles.cache.some((r) => r.name === role));

    if (discordIdOption && isAllowedRole) {
      const discordIdRowIndex = restrictedRows.findIndex(
        (row) => row[validColumns.findIndex((col) => col.toLowerCase() === 'discord_id')] === discordIdOption
      );

      if (discordIdRowIndex === -1) {
        log('warn', `[UPDATE FAILED] Discord ID not found`, {
          executor: { discord_id: userDiscordId, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
          target: { discord_id: discordIdOption },
          command: { name: commandName },
          options: updates,
        });
        await interaction.reply(`No member found with Discord ID: ${discordIdOption}`);
        return;
      }
      
      // Identify beforeState and afterState for changed fields
      const beforeState = {};
      const afterState = {};
      Object.entries(updates).forEach(([key, value]) => {
        const colIndex = validColumns.findIndex((header) => header.toLowerCase() === key.toLowerCase());
        if (colIndex !== -1 && restrictedRows[discordIdRowIndex][colIndex] !== value) {
          beforeState[key] = restrictedRows[discordIdRowIndex][colIndex];
          afterState[key] = value;
          restrictedRows[discordIdRowIndex][colIndex] = value; // Apply the update
        }
      });

      if (userId) {
        restrictedRows[discordIdRowIndex][0] = userId; // Update name
      }

      const lastUpdateColIndex = validColumns.findIndex((col) => col.toLowerCase() === 'last_update');
      restrictedRows[discordIdRowIndex][lastUpdateColIndex] = timestamp; // Update last_update column
      
      for (const [col, value] of Object.entries(updates)) {
        const colIndex = validColumns.findIndex((header) => header.toLowerCase() === col.toLowerCase());
        if (colIndex !== -1) restrictedRows[discordIdRowIndex][colIndex] = value;
      }

      // Identify beforeState and afterState for changed fields

      log('info', `[UPDATE SUCCESS] Data updated`, {
        executor: { userDisplayName, discord_id: userDiscordId, username: interaction.user.username },
        target: { name: userId, discord_id: discordIdOption },
        command: { name: commandName },
        options: updates,
        before: beforeState,
        after: afterState,
      });

      await interaction.reply(`Updated data for member: ${userId}, by: ${userDisplayName}`);
    } else {
      const rowIndex = restrictedRows.findIndex((row) => row[0]?.toLowerCase() === userId.toLowerCase());

      if (rowIndex === -1) {
        const newRow = Array(validColumns.length).fill('');
        newRow[0] = userId;
        newRow[validColumns.findIndex((col) => col.toLowerCase() === 'discord_id')] = userDiscordId;
        newRow[validColumns.findIndex((col) => col.toLowerCase() === 'display_name')] = userDisplayName;
        newRow[validColumns.findIndex((col) => col.toLowerCase() === 'last_update')] = timestamp;

        for (const [col, value] of Object.entries(updates)) {
          const colIndex = validColumns.findIndex((header) => header.toLowerCase() === col.toLowerCase());
          if (colIndex !== -1) newRow[colIndex] = value;
        }

        const firstEmptyRowIndex = restrictedRows.findIndex(row => row.every(cell => !cell || !cell.trim()));
        const targetIndex = firstEmptyRowIndex === -1 ? restrictedRows.length : firstEmptyRowIndex;
    
        restrictedRows[targetIndex] = restrictedRows[targetIndex] || Array(validColumns.length).fill('');
        restrictedRows[targetIndex] = newRow; // Assign the new data

        log('info', `[ADD SUCCESS] Data added`, {
          executor: { discord_id: userDiscordId, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
          target: { name: userId, discord_id: userDiscordId },
          command: { name: commandName },
          options: updates,
        });

        await interaction.reply(`Added new data for Member: ${userId}`);
      } else {
        const currentDiscordId = restrictedRows[rowIndex][validColumns.findIndex((col) => col.toLowerCase() === 'discord_id')];
        const currentName = restrictedRows[rowIndex][0];

        if (currentDiscordId === userDiscordId) {
          const lastUpdateColIndex = validColumns.findIndex((col) => col.toLowerCase() === 'last_update');
          const displayNameColIndex = validColumns.findIndex((col) => col.toLowerCase() === 'display_name');
          restrictedRows[rowIndex][lastUpdateColIndex] = timestamp; // Update last_update column
          restrictedRows[rowIndex][displayNameColIndex] = userDisplayName; // Update display_name column
          const beforeState = {};
          const afterState = {};

          Object.entries(updates).forEach(([key, value]) => {
            const colIndex = validColumns.findIndex((header) => header.toLowerCase() === key.toLowerCase());
            if (colIndex !== -1 && restrictedRows[rowIndex][colIndex] !== value) {
              beforeState[key] = restrictedRows[rowIndex][colIndex];
              afterState[key] = value;
              restrictedRows[rowIndex][colIndex] = value; // Apply the update
            }
          });

          log('info', `[UPDATE SUCCESS] Data updated by same user`, {
            executor: { discord_id: userDiscordId, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
            target: { name: currentName, discord_id: currentDiscordId },
            command: { name: commandName },
            options: updates,
            before: beforeState,
            after: afterState,
          });

          await interaction.reply(`Updated data for Member: ${currentName}`);
        } else {
          log('warn', `[UPDATE FAILED] Unauthorized update attempt`, {
            executor: { discord_id: userDiscordId, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
            target: { name: currentName, discord_id: currentDiscordId },
            command: { name: commandName },
            options: updates,
          });
          await interaction.reply('You do not have permission to update this member\'s data.');
        }
      }
    }

    await writeSheetData(sheets, restrictedRows);
  } catch (error) {
    log('error', 'Error handling artisan-update command', {
      executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
      error: error.message,
    });
    await interaction.reply('An error occurred while processing your update command.');
  }
}
    if (commandName === 'artisan-search') {
      const searchFor = capitalize(options.getString('search_for'));
      const columnsInput = options.getString('columns').toLowerCase();
      const level = options.getString('level') ? capitalize(options.getString('level')) : null;
      const userDisplayName = interaction.member.displayName;

      let colIndexes;
  
      // Here we are determining which columns to search
      if (columnsInput === 'any') {
          colIndexes = validColumnsearch.map((_, index) => index); // This search all columns
      } else {
          const columns = columnsInput.split(',').map((col) => col.trim());
          colIndexes = columns.map((col) => validColumnsearch.findIndex((header) => header.toLowerCase() === col.toLowerCase()));
          if (colIndexes.includes(-1)) {
            log('warn', `[SEARCH FAILED] Invalid columns specified`, {
              executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
              command: { name: commandName },
              options: { search_for: searchFor, columns: columnsInput, level },
            });
            await interaction.reply('One or more specified columns are invalid, Search_for is for Name/Profession/Expertise, Level is for only Expertise.');
            return;
          }
      }
  
      // Here we filter the search based on search_for and level value
      const filteredRows = restrictedRows.filter((row) => {
          for (const colIndex of colIndexes) {
              if (row[colIndex]?.toLowerCase() === searchFor.toLowerCase()) {
                  // If level is provided, check corresponding level column
                  if (level) {
                      const levelColumnIndex = validColumnsearch.findIndex(
                          (header) => header.toLowerCase() === `level_${validColumnsearch[colIndex].split('_')[1]}`
                      );
                      if (levelColumnIndex !== -1 && row[levelColumnIndex]?.toLowerCase() === level.toLowerCase()) {
                          return true; // This match both profession and level according to _1, _2, _3, _4, _5
                      }
                  } else {
                      return true; // Match profession only
                  }
              }
          }
          return false; // No match in the specified columns
      });
  
      if (filteredRows.length === 0) {
        log('info', `[SEARCH EMPTY] No results found`, {
          executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
          command: { name: commandName },
          options: { search_for: searchFor, columns: columnsInput, level },
        });
        await interaction.reply(`No data matches for: ${searchFor}, in ${columnsInput} column, for the level ${level} `);
        return;
      }
  
      // Generate and send the table image
      const fileName = 'filtered_table.png';
      await generateTableImage(validColumnsearch, filteredRows, fileName);
      log('info', `[SEARCH SUCCESS] Results found`, {
        executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
        command: { name: commandName },
        options: { search_for: searchFor, columns: columnsInput, level },
        results: { count: filteredRows.length },
      });
      await interaction.reply({ content: 'Filtered data:', files: [fileName] });
      fs.unlinkSync(fileName);
  }
 
  } catch (error) {
    log('error', 'Error handling artisan-search command', {
      executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
      error: error.message,
    });
    await interaction.reply('An error occurred while processing your command.');
  }
});

// Handle /artisan-logs command
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, options } = interaction;

  if (commandName === 'artisan-logs') {
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
    log('error', 'Error handling artisan-logs command', {
      executor: { discord_id: interaction.user.id, username: interaction.user.username, display_name: interaction.user.tag, userDisplayName },
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