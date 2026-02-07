import type { DaemonState } from './state';
import type { SessionInfo } from '../types';
import { MAX_MESSAGE_IDS, RANDOM_SUFFIX_RANGE } from '../constants';

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
 * Formats a Telegram thread title consistently across the daemon.
 */
export function formatThreadTitle(
  agentName: string | undefined,
  project: string,
  title: string
): string {
  const isSubagent = /subagent|task/i.test(title);
  let nameTag: string;
  if (isSubagent) {
    nameTag = agentName ? `[🧵 ${agentName}] ` : '[🧵] ';
  } else {
    nameTag = agentName ? `[${agentName}] ` : '';
  }
  return `${nameTag}${project}: ${title}`.trim();
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
