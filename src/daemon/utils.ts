import type { DaemonState } from './state';
import type { SessionInfo } from '../types';
import type { TelegramClient } from '../telegram';
import { MAX_MESSAGE_IDS, RANDOM_SUFFIX_RANGE } from '../constants';
import { log } from './logger';

/**
 * Curated list of creative names from Final Space and cult classic sci-fi
 */
export const AGENT_NAMES = [
  'Mooncake',
  'Bolo',
  'H.U.E.',
  'KVN',
  'Avocato',
  'Little Cato',
  'Tribore',
  'Biskit',
  'Nightfall',
  'Gary',
  'Quinn',
  'Ash',
  'Fox',
  'Evra',
  'Lord Commander',
  'Sames',
  'Bishop',
  'Roy Batty',
  'Data',
  'GLaDOS',
  'Bender',
  'HAL 9000',
  'Marvin',
  'Robby the Robot',
  'Johnny 5',
  'K.I.T.T.',
  'Max Headroom',
  'Wheatley',
  'HK-47',
  'Legion',
];

/**
 * Funny suffixes for subagent names, appended to the parent's name.
 * e.g. "Mochi Jr." or "Mochi's Shadow"
 */
export const SUBAGENT_SUFFIXES = [
  'Jr.',
  "'s Shadow",
  "'s Minion",
  "'s Sidekick",
  'Mini',
  "'s Intern",
  "'s Clone",
  "'s Echo",
  "'s Apprentice",
  "'s Gremlin",
  "'s Ghost",
  "'s Buddy",
  "'s Spawn",
  '2.0',
  "'s Familiar",
];

/**
 * Generates a random agent name, ensuring it's not already taken.
 * If all names are taken, it appends a random suffix.
 */
export function getRandomAgentName(state: DaemonState): string {
  const takenNames = new Set(
    Array.from(state.sessions.values())
      .map((s) => s.agentName?.toLowerCase())
      .filter(Boolean)
  );

  const availableNames = AGENT_NAMES.filter((name) => !takenNames.has(name.toLowerCase()));

  if (availableNames.length > 0) {
    return availableNames[Math.floor(Math.random() * availableNames.length)];
  }

  // Fallback if all names are taken - ensure uniqueness with suffix
  const base = AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
  let attempt = 0;
  const maxAttempts = 100;

  while (attempt < maxAttempts) {
    const candidate = `${base}-${Math.floor(Math.random() * RANDOM_SUFFIX_RANGE)}`;
    if (!takenNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    attempt++;
  }

  // Ultimate fallback with timestamp if somehow still colliding
  return `${base}-${Date.now() % RANDOM_SUFFIX_RANGE}`;
}

/**
 * Generates a subagent name derived from the parent session's name.
 * Looks up the parent's agentName and appends a random funny suffix.
 * e.g. "Mochi" -> "Mochi Jr." or "Mochi's Shadow"
 */
export function getSubagentName(parentSessionID: string, state: DaemonState): string {
  const parentSession = state.sessions.get(parentSessionID);
  const parentName = parentSession?.agentName || 'Agent';

  const takenNames = new Set(
    Array.from(state.sessions.values())
      .map((s) => s.agentName?.toLowerCase())
      .filter(Boolean)
  );

  // Try each suffix randomly until we find one not taken
  const shuffled = [...SUBAGENT_SUFFIXES].sort(() => Math.random() - 0.5);
  for (const suffix of shuffled) {
    const candidate = `${parentName} ${suffix}`;
    if (!takenNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // Fallback: append a number
  return `${parentName} #${Math.floor(Math.random() * RANDOM_SUFFIX_RANGE)}`;
}

/**
 * Formats a Telegram thread title consistently across the daemon.
 * Uses session.parentID to determine subagent status (explicit, not heuristic).
 *
 * Format: "AgentName title" or "AgentName project: title"
 * - Omits project prefix when title equals project name (avoids "proj: proj")
 * - Omits project prefix when title already contains the project name
 * - Strips agent name from title start if duplicated (avoids "Mochi proj: Mochi: task")
 */
export function formatThreadTitle(
  agentName: string | undefined,
  project: string,
  title: string,
  isSubagent = false
): string {
  let nameTag: string;
  if (isSubagent) {
    nameTag = agentName ? `🧵 ${agentName} ` : '🧵 ';
  } else {
    nameTag = agentName ? `${agentName} ` : '';
  }

  // Strip agent name from start of title if present (prevents duplication)
  // e.g. agentName="Mochi", title="Mochi: Build feature" → title="Build feature"
  let cleanTitle = title;
  if (agentName) {
    const lowerTitle = cleanTitle.toLowerCase();
    const lowerName = agentName.toLowerCase();
    if (lowerTitle.startsWith(lowerName)) {
      const stripped = cleanTitle.slice(agentName.length).replace(/^[:\s]+/, '').trim();
      if (stripped) {
        cleanTitle = stripped;
      }
    }
  }

  // Skip project prefix if title IS the project name or already contains it
  const titleLower = cleanTitle.toLowerCase();
  const projectLower = project.toLowerCase();
  const skipProject =
    titleLower === projectLower ||
    titleLower.includes(projectLower);

  const body = skipProject ? cleanTitle : `${project}: ${cleanTitle}`;
  return `${nameTag}${body}`.trim();
}

/**
 * Renders a Markdown status dashboard for a session.
 */
export function renderStatusDashboard(session: SessionInfo): string {
  const persona = session.agentType || 'Unknown';
  const identity = session.agentName || 'None';
  const model = session.model || 'Unknown';
  const project = session.project || 'Unknown';
  const status = session.status || 'idle';

  let statusEmoji = '⚪';
  if (status === 'busy') statusEmoji = '🟡';
  if (status === 'idle') statusEmoji = '🟢';
  if (status === 'disconnected') statusEmoji = '🔴';

  return [
    `🤖 **Agent:** \`${persona}\``,
    `👤 **Identity:** ${identity}`,
    `🛠️ **Model:** \`${model}\``,
    `📁 **Project:** \`${project}\``,
  ].join('\n');
}

export const dashboardCache = new Map<string, string>();

/**
 * Updates the pinned status dashboard message for a session.
 */
export async function syncStatusDashboard(session: SessionInfo, bot: TelegramClient): Promise<void> {
  if (!session.chatId) return;
  // Need either an existing dashboard to edit or a thread to create one in
  if (!session.statusMessageID && !session.threadID) return;

  const text = renderStatusDashboard(session);
  const cached = dashboardCache.get(session.sessionID);

  if (cached === text) {
    return;
  }

  // Try to edit existing dashboard
  if (session.statusMessageID) {
    try {
      const result = await bot.editMessageText({
        chat_id: session.chatId,
        message_id: session.statusMessageID,
        text,
        parse_mode: 'Markdown',
      });

      if (result.ok) {
        dashboardCache.set(session.sessionID, text);
        return;
      }

      const desc = result.description || '';
      // "message is not modified" means state is already consistent
      if (desc.includes('message is not modified')) {
        dashboardCache.set(session.sessionID, text);
        return;
      }
      // Message not found or other error — fall through to recreate
      log(`[Daemon] Dashboard edit failed for ${session.sessionID}: ${desc}, recreating`, 'warn');
      session.statusMessageID = undefined;
    } catch (err) {
      log(`[Daemon] Dashboard edit error for ${session.sessionID}: ${err}, recreating`, 'warn');
      session.statusMessageID = undefined;
    }
  }

  // Create new dashboard (or recreate after deletion)
  if (!session.threadID) return;
  try {
    const res = await bot.sendMessage({
      chat_id: session.chatId,
      message_thread_id: session.threadID,
      text,
      parse_mode: 'Markdown',
    });
    if (res.ok) {
      session.statusMessageID = res.result.message_id;
      dashboardCache.set(session.sessionID, text);
      await bot.pinChatMessage({
        chat_id: session.chatId,
        message_id: session.statusMessageID,
        disable_notification: true,
      });
    }
  } catch (err) {
    log(`[Daemon] Failed to create dashboard for ${session.sessionID}: ${err}`, 'warn');
  }
}

/**
 * Adds a message ID to the session's messageIDs array and caps it at MAX_MESSAGE_IDS.
 * Removes oldest entries when the limit is exceeded.
 */
export function addMessageID(session: SessionInfo, messageID: number): void {
  if (!session.messageIDs) {
    session.messageIDs = [];
  }
  session.messageIDs.push(messageID);
  if (session.messageIDs.length > MAX_MESSAGE_IDS) {
    session.messageIDs = session.messageIDs.slice(-MAX_MESSAGE_IDS);
  }
}
