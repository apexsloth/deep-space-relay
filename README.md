# Deep Space Relay

**Chat with our astronauts while they are in deep space.**

Message your OpenCode agents directly via Telegram. Each project can have its own chat, and every session has a dedicated thread for real-time interaction.

## Features

*   **Per Project Chat:** Each workspace can have its own dedicated Telegram Forum Topic.
*   **Session Threads:** Every agent session has its own thread within the project chat.
*   **Message Your Agents:** Send messages that inject directly into the agent's context.
*   **Remote Control:** Stop execution (`/stop`) and manage sessions. (Tool approval coming soon when OpenCode supports it).
*   **Live Updates:** Agents broadcast status and send idle reminders.

## Installation

### 1. Install Plugin
Install the package into your OpenCode cache directory so it can be loaded:

```bash
npm install --prefix ~/.cache/opencode deep-space-relay
```

### 2. Setup & Configure
Run the interactive setup to configure your Telegram bot token and chat ID:

```bash
npx deep-space-relay setup
```

### 3. Start the Daemon
The daemon bridges OpenCode and Telegram. Keep it running in the background:

```bash
npx deep-space-relay start
```

### 4. Enable in OpenCode
Add the plugin to your `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    "deep-space-relay"
  ]
}
```

## Commands

*   `npx deep-space-relay status` - Check daemon connection.
*   `npx deep-space-relay stop` - Stop the background daemon.
*   `npx deep-space-relay help` - Show all commands.
