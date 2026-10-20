import type { ControlPlaneAnswerReply } from '../../../src/shared/control-plane-protocol.js';
import type { BoundedSlashCommandCatalog } from '../../../src/shared/slash-commands.js';
import type { WorktreeKiloCleanupClient } from '../control/delete-worktree.js';
import type { CondenseResult } from '../condense-on-complete.js';
import type { SessionObservation } from './session-supervisor.js';
import type { WrapperKiloClient } from '../kilo-api.js';

export type HarnessSession = { sessionId: string; directory: string; signal?: AbortSignal };
export type HarnessPrompt = HarnessSession & {
  messageId: string;
  prompt?: string;
  parts?: Array<
    { type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }
  >;
  agent?: string;
  model?: string;
  variant?: string;
};
export type HarnessObservationInput = {
  directory: string;
  observedDirectories: Iterable<string>;
  knownSessions: Array<{ id: string; directory: string; messageIds: string[] }>;
  signal: AbortSignal;
};
export type HarnessTerminal = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
};
export type HarnessTerminals = {
  createPty(input: {
    cwd: string;
    title: string;
    env: Record<string, string>;
  }): Promise<HarnessTerminal>;
  resizePty(
    id: string,
    size: { cols: number; rows: number },
    directory?: string
  ): Promise<HarnessTerminal>;
  deletePty(id: string, directory?: string): Promise<boolean>;
  connectPty(id: string, directory: string): WebSocket;
  isIdle(directory: string, signal: AbortSignal): Promise<boolean>;
};

export type HarnessReads = Pick<
  WrapperKiloClient,
  | 'getSessionDetails'
  | 'getRecentSessionMessages'
  | 'getSessionStatuses'
  | 'getSessionTodos'
  | 'getSessionDiff'
  | 'getQuestions'
  | 'getPermissions'
>;

export type Harness = {
  open(
    input: HarnessSession & {
      env: Record<string, string>;
      restoreFiles: boolean;
      onRestore(): void;
    }
  ): Promise<boolean>;
  submit(input: HarnessPrompt): Promise<void>;
  command(
    input: HarnessSession & {
      command: string;
      args?: string;
      messageId?: string;
      agent?: string;
      model?: string;
      variant?: string;
    }
  ): Promise<void>;
  compact(input: HarnessSession & { model: string; auto?: boolean }): Promise<boolean>;
  condense(input: HarnessSession & { model: string }): Promise<CondenseResult>;
  answer(input: {
    directory: string;
    reply: ControlPlaneAnswerReply;
    interactive?: boolean;
    signal?: AbortSignal;
  }): Promise<boolean>;
  interrupt(input: HarnessSession): Promise<boolean>;
  observe(input: HarnessObservationInput): Promise<SessionObservation[]>;
  release(input: HarnessSession & { deadlineMs: number; signal: AbortSignal }): Promise<{
    ok: boolean;
    sessions: number;
    failures: number;
    elapsedMs: number;
  }>;
  listCommands(): Promise<BoundedSlashCommandCatalog>;
  generateCommitMessage(input: {
    path: string;
    signal?: AbortSignal;
  }): Promise<{ message: string }>;
  isUnavailableError(error: unknown): boolean;
  reads: HarnessReads;
  terminals: HarnessTerminals;
  worktree: WorktreeKiloCleanupClient;
};
