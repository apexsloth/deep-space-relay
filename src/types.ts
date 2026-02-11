// ============================================================
// SHARED TYPES
// ============================================================

// Project type matches OpenCode SDK Project structure
export interface Project {
  id: string;
  worktree: string;
  vcsDir?: string;
  vcs?: 'git';
  time: {
    created: number;
    initialized?: number;
  };
}

export interface PluginContext {
  directory: string;
  worktree?: string;
  project?: Project;
  client: {
    app: {
      log: (options: {
        body: {
          service: string;
          level: 'debug' | 'info' | 'warn' | 'error';
          message: string;
          extra?: Record<string, unknown>;
        };
      }) => Promise<void>;
    };
    session: {
      prompt: (options: {
        path: { id: string };
        body: { parts: Array<{ type: string; text: string }> };
        query: { directory: string };
      }) => Promise<unknown>;
      abort: (options: { path: { id: string }; query: { directory: string } }) => Promise<unknown>;
      get: (options: {
        path: { id: string };
        query: { directory: string };
      }) => Promise<{ data?: { title?: string } }>;
      messages: (options: { path: { id: string }; query: { directory: string } }) => Promise<{
        data?: Array<{
          info?: Record<string, unknown>;
          parts?: Array<{ type: string; text?: string }>;
        }>;
      }>;
      list: (options?: {
        query?: { directory?: string };
      }) => Promise<{
        data?: Array<{
          id: string;
          title: string;
          parentID?: string;
          time: { created: number; updated: number };
        }>;
      }>;
      shell: (options: {
        path: { id: string };
        body: { command: string };
        query: { directory: string };
      }) => Promise<unknown>;
      revert: (options: { path: { id: string }; query: { directory: string } }) => Promise<unknown>;
      unrevert: (options: {
        path: { id: string };
        query: { directory: string };
      }) => Promise<unknown>;
    };
    // Top-level method on OpencodeClient for responding to permission requests
    // Used by the permission.ask hook to respond from Telegram
    postSessionIdPermissionsPermissionId: (options: {
      path: { id: string; permissionID: string };
      body?: { response: string };
      query?: { directory?: string };
    }) => Promise<{ data?: boolean }>;
  };
}

export type LogFn = (
  message: string,
  level?: 'debug' | 'info' | 'warn' | 'error',
  extra?: Record<string, unknown>
) => void;

// Daemon types
export interface SessionInfo {
  sessionID: string;
  project: string;
  title: string;
  chatId?: string; // Per-session chatId (from plugin)
  threadID?: number;
  threadVerified?: boolean; // true = last Telegram send succeeded, false/undefined = needs reconcile
  agentName?: string;
  parentID?: string; // Parent session ID (for subagents)
  model?: string; // e.g. "anthropic/claude-sonnet-4-20250514"
  agentType?: string; // e.g. "code", "research", "explore"
  status?: 'idle' | 'busy' | 'disconnected';
  disconnectedAt?: number; // Timestamp when session disconnected (for auto-cleanup)
  pendingPermissions: Map<string, number>; // permissionID -> messageID
  pendingAsks: Map<string, string[]>; // askID -> options
  messageQueue: string[];
  lastMessageID?: number;
  statusMessageID?: number;
  messageIDs: number[]; // Track all message IDs
}

// Relay types
export interface RelayConfig {
  project: string;
  directory: string;
  chatId?: string; // Per-session chatId (from project config)
  log: LogFn;
  onMessage?: (text: string, isThread: boolean, messageID?: number) => void;
  onCommand?: (command: string, messageID?: number) => void;
  onShell?: (command: string, messageID?: number) => void;
  onPermissionResponse?: (permissionID: string, action: string) => void;
  onStop?: () => void;
  socketPath?: string; // Optional override for testing
  ipcToken?: string; // IPC authentication token
}

export interface RelayState {
  socket: import('net').Socket | null;
  registered: boolean;
  hasThread: boolean;
  sessionID: string | null;
  lastMessageID?: number;
  title?: string;
}

// Telegram types
export interface TelegramConfig {
  botToken: string;
  apiUrl?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReaction;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
  chat: { id: number | string };
  message_thread_id?: number;
  reply_to_message?: TelegramMessage;
  forum_topic_created?: boolean;
  forum_topic_edited?: boolean;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: { id: number; first_name?: string; username?: string };
  data?: string;
  message: TelegramMessage;
}

export interface TelegramMessageReaction {
  message_id: number;
  new_reaction: Array<{ type: string; emoji?: string }>;
  user?: { first_name?: string };
}

// Socket message types (plugin <-> daemon communication)
export interface SocketMessage {
  type: string;
  sessionID?: string;
  [key: string]: unknown;
}

export interface RegisterMessage extends SocketMessage {
  type: 'register';
  project?: string;
  title?: string;
}

export interface SendMessage extends SocketMessage {
  type: 'send';
  text: string;
}

export interface BroadcastMessage extends SocketMessage {
  type: 'broadcast';
  text: string;
}

export interface AskMessage extends SocketMessage {
  type: 'ask';
  askID: string;
  question: string;
  options: string[];
}

export interface PermissionMessage extends SocketMessage {
  type: 'permission_request';
  permissionID: string;
  tool: string;
  description?: string;
}

export interface ShellMessage extends SocketMessage {
  type: 'shell';
  command: string;
  messageID?: number;
}

export interface CommandMessage extends SocketMessage {
  type: 'command';
  command: string;
  messageID?: number;
}
