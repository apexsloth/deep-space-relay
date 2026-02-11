/**
 * Deep Space Relay Constants
 *
 * All magic numbers and configuration values are centralized here for easy maintenance.
 */

// ============================================================
// TIMEOUTS & DELAYS (all in milliseconds)
// ============================================================

/** General IPC request timeout (10 seconds) */
export const IPC_REQUEST_TIMEOUT_MS = 10000;

/** Permission request timeout (5 minutes) */
export const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Ask/question request timeout (10 minutes) */
export const ASK_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Config fetch timeout (5 seconds) */
export const CONFIG_FETCH_TIMEOUT_MS = 5000;

/** Standby retry interval (30 seconds) */
export const STANDBY_RETRY_MS = 30000;

/** Heartbeat check timeout (10 seconds) */
export const HEARTBEAT_TIMEOUT_MS = 10000;

/** Force shutdown timeout (5 seconds) */
export const FORCE_SHUTDOWN_TIMEOUT_MS = 5000;

/** Idle debounce delay - minimum time between idle summaries (10 seconds) */
export const IDLE_DEBOUNCE_MS = 10000;

/** Abort grace window - ignore events within this time after abort (3 seconds) */
export const ABORT_GRACE_WINDOW_MS = 3000;

/** CLI daemon connection timeout (3 seconds) */
export const CLI_CONNECT_TIMEOUT_MS = 3000;

/** CLI command timeout (5 seconds) */
export const CLI_COMMAND_TIMEOUT_MS = 5000;

/** Short delay for cleanup/graceful shutdown (500ms) */
export const SHORT_DELAY_MS = 500;

/** Medium delay for retry operations (1 second) */
export const MEDIUM_DELAY_MS = 1000;

/** Delay before retrying a stale leader check when socket exists but connection failed (2 seconds) */
export const STALE_CHECK_RETRY_DELAY_MS = 2000;

/** Retry delay between connection attempts (100ms) */
export const RETRY_DELAY_MS = 100;

/** Long retry delay for error recovery (5 seconds) */
export const LONG_RETRY_DELAY_MS = 5000;

/** Telegram API success delay between requests (100ms) */
export const TELEGRAM_SUCCESS_DELAY_MS = 100;

/** Telegram API error retry delay (5 seconds) */
export const TELEGRAM_ERROR_RETRY_MS = 5000;

/** Auth timeout check interval (100ms) */
export const AUTH_CHECK_INTERVAL_MS = 100;

// ============================================================
// BUFFER & MESSAGE LIMITS
// ============================================================

/** Maximum buffer size to prevent memory exhaustion (10MB) */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/** Maximum length for compaction summary sent to Telegram */
export const MAX_COMPACTION_SUMMARY_LENGTH = 3500;

/** Maximum length for idle summary sent to Telegram */
export const MAX_IDLE_SUMMARY_LENGTH = 3000;

/** Maximum number of message IDs to track per session */
export const MAX_MESSAGE_IDS = 100;

// ============================================================
// NETWORK & HTTP CONSTANTS
// ============================================================

/** HTTP 429 Too Many Requests status code */
export const HTTP_TOO_MANY_REQUESTS = 429;

/** Base backoff delay for exponential backoff (100ms) */
export const BACKOFF_BASE_DELAY_MS = 100;

/** Initial polling error backoff delay (1 second) */
export const POLLING_INITIAL_BACKOFF_MS = 1000;

/** Maximum polling error backoff delay (60 seconds) */
export const POLLING_MAX_BACKOFF_MS = 60000;

/** Polling backoff multiplier (doubles each time) */
export const POLLING_BACKOFF_MULTIPLIER = 2;

// ============================================================
// TIME CONVERSION CONSTANTS
// ============================================================

/** Milliseconds per second */
export const MS_PER_SECOND = 1000;

/** Seconds per minute */
export const SECONDS_PER_MINUTE = 60;

/** Seconds per hour */
export const SECONDS_PER_HOUR = 3600;

/** Minutes per hour */
export const MINUTES_PER_HOUR = 60;

/** Bytes per kilobyte */
export const BYTES_PER_KB = 1024;

/** Kilobytes per megabyte */
export const KB_PER_MB = 1024;

/** Milliseconds per day */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Maximum age for auto-connect sessions (24 hours) */
export const AUTO_CONNECT_MAX_AGE_MS = MS_PER_DAY;

/** Days to keep disconnected sessions before auto-cleanup (7 days) */
export const SESSION_CLEANUP_DAYS = 7;

// ============================================================
// TELEGRAM CONSTANTS
// ============================================================

/** Telegram chat ID prefix length for stripping (-100) */
export const TELEGRAM_CHAT_ID_PREFIX_LENGTH = 4;

/** Maximum retry time for rate limiting (in seconds) */
export const TELEGRAM_MAX_RETRY_AFTER_HOURS = 1;

// ============================================================
// SYSTEM CONSTANTS
// ============================================================

/** Directory permission mode for secure directories (0700 - owner only) */
export const SECURE_DIR_MODE = 0o700;

/** Random suffix range for generating unique names */
export const RANDOM_SUFFIX_RANGE = 1000;

/** Base for parseInt operations */
export const PARSE_INT_RADIX = 10;
