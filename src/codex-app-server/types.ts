export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result: TResult;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: JsonRpcError;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export interface CodexClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface CodexInitializeParams {
  clientInfo: CodexClientInfo;
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
}

export interface CodexThreadConfig {
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  personality?: 'friendly' | 'pragmatic' | 'none';
  serviceName?: string;
  dynamicTools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  persistExtendedHistory?: boolean;
}

export interface CodexInputTextItem {
  type: 'text';
  text: string;
}

export type CodexInputItem = CodexInputTextItem | Record<string, unknown>;

export interface CodexThread {
  id: string;
  preview?: string;
  status?: {
    type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  threadId?: string;
  status?: string;
  items?: unknown[];
  [key: string]: unknown;
}

export interface CodexThreadResult {
  thread: CodexThread;
}

export interface CodexTurnResult {
  turn: CodexTurn;
}

export interface CodexTurnSteerResult {
  turnId: string;
}

export interface CodexThreadStartParams extends CodexThreadConfig {}

export interface CodexThreadResumeParams extends CodexThreadConfig {
  threadId: string;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: CodexInputItem[];
}

export interface CodexTurnSteerParams {
  threadId: string;
  input: CodexInputItem[];
  expectedTurnId: string;
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface CodexAppServerSpawnConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CodexConversationState {
  localSessionId: string;
  threadId: string;
  activeTurnId?: string;
  status: 'idle' | 'busy';
  cwd?: string;
  title?: string;
}

export interface CodexSessionRegistration {
  localSessionId: string;
  threadId?: string;
  cwd?: string;
  title?: string;
  threadConfig?: CodexThreadConfig;
}
