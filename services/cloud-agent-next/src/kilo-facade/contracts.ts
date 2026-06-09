import type { BalanceOnlyResult } from '../balance-validation.js';
import type {
  SessionMessageAdmissionResult,
  SubmittedSessionMessageRequest,
} from '../execution/types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { SessionStatus } from '../shared/protocol.js';
import type { SlashCommandInfo } from '../shared/slash-commands.js';
import type { Env } from '../types.js';
import type {
  LiveWrapperTarget,
  SessionKiloFacadeDecision,
  SessionKiloFacadePolicyInput,
} from './session-proxy.js';

export type KiloFacadeGlobalEvents = {
  getPublicSessionStatuses?(kiloSessionId?: string): Record<string, SessionStatus>;
  openPublicGlobalEventStream(userId: string): Response;
  openPublicSessionEventStream(userId: string, kiloSessionId: string): Response;
};

export type KiloFacadeRequestDeps = {
  resolveRootSessionForKiloSession?: (params: {
    env: Env;
    userId: string;
    kiloSessionId: string;
  }) => Promise<{ cloudAgentSessionId: string } | null>;
  decideSessionRoute?: (input: SessionKiloFacadePolicyInput) => SessionKiloFacadeDecision;
  resolveLiveWrapper?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<LiveWrapperTarget | null>;
  admitPrompt?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
    request: SubmittedSessionMessageRequest;
  }) => Promise<SessionMessageAdmissionResult>;
  validatePromptBalance?: (params: {
    env: Env;
    authToken: string;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<BalanceOnlyResult>;
  getAvailableCommands?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<SlashCommandInfo[]>;
  admitCommand?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
    request: SubmittedSessionMessageRequest;
  }) => Promise<SessionMessageAdmissionResult>;
  validateCommandBalance?: (params: {
    env: Env;
    authToken: string;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<BalanceOnlyResult>;
  interruptPrompt?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<Awaited<ReturnType<CloudAgentSession['interruptExecution']>>>;
  globalEvents?: KiloFacadeGlobalEvents;
};

export type KiloFacadeHandlerContext = {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  deps?: KiloFacadeRequestDeps;
  url: URL;
  kiloPath: string;
};

export type SelectedOwnedRootHandlerContext = KiloFacadeHandlerContext & {
  kiloSessionId: string;
  cloudAgentSessionId: string;
};

export type OwnedRootHandlerContext = SelectedOwnedRootHandlerContext & {
  encodedKiloSessionId: string;
};
