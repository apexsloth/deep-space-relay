import type { LogFn } from '../types';
import { CodexAppServerClient } from './client';
import type {
  CodexConversationState,
  CodexInitializeParams,
  CodexInputItem,
  CodexSessionRegistration,
  JsonRpcNotification,
} from './types';

export class CodexSessionManager {
  private readonly sessions = new Map<string, CodexConversationState>();

  constructor(
    private readonly client: Pick<
      CodexAppServerClient,
      | 'initialize'
      | 'onNotification'
      | 'threadStart'
      | 'threadResume'
      | 'turnStart'
      | 'turnSteer'
      | 'turnInterrupt'
    >,
    private readonly log: LogFn
  ) {
    this.client.onNotification((message) => {
      this.handleNotification(message);
    });
  }

  public async initialize(params: CodexInitializeParams): Promise<void> {
    await this.client.initialize(params);
  }

  public async registerSession(registration: CodexSessionRegistration): Promise<CodexConversationState> {
    const existing = this.sessions.get(registration.localSessionId);
    if (existing) {
      return existing;
    }

    let threadId = registration.threadId;
    if (threadId) {
      const response = await this.client.threadResume({
        threadId,
        ...(registration.threadConfig || {}),
      });
      threadId = response.thread.id;
    } else {
      const response = await this.client.threadStart({
        ...(registration.threadConfig || {}),
        ...(registration.cwd ? { cwd: registration.cwd } : {}),
      });
      threadId = response.thread.id;
    }

    const state: CodexConversationState = {
      localSessionId: registration.localSessionId,
      threadId,
      status: 'idle',
      cwd: registration.cwd,
      title: registration.title,
    };
    this.sessions.set(registration.localSessionId, state);
    return state;
  }

  public getSession(localSessionId: string): CodexConversationState | undefined {
    return this.sessions.get(localSessionId);
  }

  public listSessions(): CodexConversationState[] {
    return [...this.sessions.values()];
  }

  public async injectMessage(
    localSessionId: string,
    text: string,
    options: {
      registration?: Omit<CodexSessionRegistration, 'localSessionId'>;
      extraInput?: CodexInputItem[];
    } = {}
  ): Promise<CodexConversationState> {
    const state =
      this.sessions.get(localSessionId) ||
      (await this.registerSession({
        localSessionId,
        ...(options.registration || {}),
      }));
    const input: CodexInputItem[] = [{ type: 'text', text }, ...(options.extraInput || [])];

    if (state.activeTurnId) {
      const result = await this.client.turnSteer({
        threadId: state.threadId,
        input,
        expectedTurnId: state.activeTurnId,
      });
      state.activeTurnId = result.turnId;
      state.status = 'busy';
      return state;
    }

    const result = await this.client.turnStart({
      threadId: state.threadId,
      input,
    });
    state.activeTurnId = result.turn.id;
    state.status = 'busy';
    return state;
  }

  public async interrupt(localSessionId: string): Promise<void> {
    const state = this.sessions.get(localSessionId);
    if (!state?.activeTurnId) {
      return;
    }

    await this.client.turnInterrupt({
      threadId: state.threadId,
      turnId: state.activeTurnId,
    });
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method === 'turn/started') {
      const turn = this.extractTurn(message.params);
      if (!turn?.id) {
        return;
      }
      const state = this.findByThreadId(turn.threadId);
      if (!state) {
        return;
      }
      state.activeTurnId = turn.id;
      state.status = 'busy';
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = this.extractTurn(message.params);
      if (!turn?.id) {
        return;
      }
      const state = this.findByThreadId(turn.threadId);
      if (!state) {
        return;
      }
      if (state.activeTurnId === turn.id) {
        state.activeTurnId = undefined;
      }
      state.status = 'idle';
    }
  }

  private extractTurn(params: unknown): { id?: string; threadId?: string } | undefined {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return undefined;
    }
    const turn = (params as Record<string, unknown>).turn;
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
      this.log('Ignoring Codex notification without turn payload', 'debug', { params });
      return undefined;
    }
    const turnRecord = turn as Record<string, unknown>;
    return {
      id: typeof turnRecord.id === 'string' ? turnRecord.id : undefined,
      threadId: typeof turnRecord.threadId === 'string' ? turnRecord.threadId : undefined,
    };
  }

  private findByThreadId(threadId?: string): CodexConversationState | undefined {
    if (!threadId) {
      return undefined;
    }

    return [...this.sessions.values()].find((session) => session.threadId === threadId);
  }
}
