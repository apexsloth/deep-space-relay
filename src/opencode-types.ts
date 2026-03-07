import type {
  RuntimeSessionGetResult,
  RuntimeSessionMessagesResult,
  RuntimeSessionPromptBody,
  RuntimeSessionQuery,
  RuntimeSessionPath,
} from './types';

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

export interface OpenCodeResult<T> {
  data?: T;
  error?: unknown;
}

export interface OpenCodePluginContext {
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
        path: RuntimeSessionPath;
        body: RuntimeSessionPromptBody & {
          model?: { providerID: string; modelID: string };
          agent?: string;
        };
        query: RuntimeSessionQuery;
      }) => Promise<OpenCodeResult<unknown>>;
      abort: (options: { path: RuntimeSessionPath; query: RuntimeSessionQuery }) => Promise<unknown>;
      get: (options: {
        path: RuntimeSessionPath;
        query: RuntimeSessionQuery;
      }) => Promise<RuntimeSessionGetResult>;
      messages: (options: {
        path: RuntimeSessionPath;
        query: RuntimeSessionQuery;
      }) => Promise<OpenCodeResult<RuntimeSessionMessagesResult['data']>>;
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
        path: RuntimeSessionPath;
        body: { command: string };
        query: RuntimeSessionQuery;
      }) => Promise<unknown>;
      revert: (options: { path: RuntimeSessionPath; query: RuntimeSessionQuery }) => Promise<unknown>;
      unrevert: (options: {
        path: RuntimeSessionPath;
        query: RuntimeSessionQuery;
      }) => Promise<unknown>;
    };
    postSessionIdPermissionsPermissionId: (options: {
      path: { id: string; permissionID: string };
      body?: { response: string };
      query?: { directory?: string };
    }) => Promise<{ data?: boolean }>;
  };
}
