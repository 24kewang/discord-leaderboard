# Discord Leaderboard

A comprehensive Discord bot for managing event attendance, points tracking, and leaderboard management. This bot integrates with Google Sheets to maintain a persistent points system across multiple events, with support for various event types and member attendance verification.

## Features

- **Event Management**: Add, view, and manage events with customizable event types and point values
- **Attendance Tracking**: Generate QR codes for event check-in and validate attendance within a configurable time window
- **Leaderboard**: Display member points and rankings with anonymous submission support
- **Points System**: Flexible event-based point assignment (General Meeting, Technical Workshop, Tech Talk, Social)
- **Google Sheets Integration**: Seamless data synchronization with Google Sheets for event codes, point records, and event details
- **Logging**: Comprehensive daily-rotated logging with staff and admin access to logs
- **Role-Based Access Control**: Different permission levels for users, staff, and admins

## Prerequisites

- Node.js (v18+)
- npm
- Discord bot token and credentials
- Google Sheets API credentials and spreadsheet
- A Discord server where you have admin permissions

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/24kewang/discord-leaderboard.git
   cd discord-leaderboard
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

## Configuration

Create a `.env` file in the project root with the following environment variables:

```env
# Discord Configuration
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
GUILD_ID=your_guild_id_here

# Google Sheets Configuration
SPREADSHEET_ID=your_spreadsheet_id_here
CREDENTIALS_PATH=./credentials/sheets-api-key.json

# Optional: Custom sheet names (defaults provided)
EVENTS_SHEET=Event Codes
POINTS_SHEET=Points Record
TYPES_SHEET=Points System
```

### Google Sheets Setup

1. Create a Google Sheets spreadsheet with the following sheets:
   - **Event Codes**: Contains event information (Date, Start Time, End Time, Event Name, Event Type, Event Code)
   - **Points System**: Maps event types to point values (Event Type, Points)
   - **Points Record**: Member attendance and points (NetID, First Name, Last Name, Anonymous, Points, Last Update)
   - **Form Responses**: Form submission data (used by the Google Apps Script)

2. Set up Google Sheets API:
   - Create a service account in Google Cloud Console
   - Download the credentials JSON file
   - Place it in the `credentials/` folder as `sheets-api-key.json`
   - Share your spreadsheet with the service account email

3. Set up the Google Apps Script (`SheetUpdate.gs`):
   - Open your Google Sheet
   - Go to Extensions → Apps Script
   - Copy the contents of `SheetUpdate.gs` into the script editor
   - Deploy and set up the auto-update trigger from the "Leaderboard Manager" menu

## Usage

### Running the Bot

**Development (with auto-reload):**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

### Available Commands

All commands use Discord's slash command interface. Available commands include:

- `/view-leaderboard` - [MEMBER] Display the current leaderboard with member rankings
- `/membership-logs` - [ADMIN] View membership and attendance logs (staff/admin only)
- `/add-event` - [STAFF] Add a new event to the system (staff/admin only)
- `/show-event-list` - [STAFF] Display all upcoming and past events
- `/get-attendance-qr` - [STAFF] Generate and display a QR code for event check-in
- `/show-point-system` - [MEMBER] Display the point values for each event type

### Google Apps Script (SheetUpdate.gs)

The `SheetUpdate.gs` file handles automatic point updates:

1. Processes form submissions from the "Form Responses" sheet
2. Matches submissions to events based on event codes and timestamps
3. Validates attendance within the configured time window (default: 30 minutes before/after event)
4. Updates the Points Record sheet with member point totals

To enable auto-updates:
1. Open the Google Sheet
2. Go to "Leaderboard Manager" menu → "Set Up Auto-Update (24hr)"
3. The script will run automatically every 24 hours

## Project Structure

```
discord-leaderboard/
├── index.js                    # Main bot implementation
├── SheetUpdate.gs             # Google Apps Script for point updates
├── package.json               # Node.js dependencies
├── .env                       # Environment variables (not in repo)
├── credentials/               # Google API credentials
│   └── sheets-api-key.json
├── logs/                      # Daily bot activity logs
└── assets/                    # Static assets (QR codes, images)
```

## Logging

- Logs are stored in the `logs/` directory with daily rotation
- Staff and admins can view logs via Discord commands
- Both file and console output are supported