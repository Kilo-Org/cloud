import { type LocalSessionCreateRecovery } from './local-session-create-errors';
import { type LocalSessionRequestIdStore } from './local-session-request-id';
import { type LocalRuntimeCatalog, type LocalRuntimeFence } from './local-runtime-catalog-types';
import { type CreateAndRunResult, type HapticKind } from './local-session-create-effects';
import { type ReadinessProbe } from './local-session-create-polling';
import {
  type BuildLocalSessionCreateRequestInput,
  type BuiltLocalSessionCreateRequest,
  type LocalSessionCreateRequestError,
} from './local-session-create-request';

export type { HapticKind };
export type { LocalSessionCreateRecovery };
export type { ReadinessProbe };

export type LocalSessionCreateOrchestratorDeps = {
  requestIdStore: LocalSessionRequestIdStore;
  buildRequest: (input: BuildLocalSessionCreateRequestInput) => BuiltLocalSessionCreateRequest;
  createAndRun: (input: BuiltLocalSessionCreateRequest) => Promise<CreateAndRunResult>;
  pollReadiness: ReadinessProbe;
  sleep: (ms: number) => Promise<void>;
  invalidateCaches: () => Promise<void>;
  captureEvent: (name: string, properties: Record<string, unknown>) => void;
  notificationHaptic: (kind: HapticKind) => void;
  navigate: (path: string) => void;
  showError: (message: string) => void;
  showInfo: (message: string) => void;
  pollIntervalMs: number;
  pollMaxMs: number;
};

export type LocalSessionCreateOrchestratorInput = {
  deps: LocalSessionCreateOrchestratorDeps;
  fence: LocalRuntimeFence;
  catalog: LocalRuntimeCatalog;
  selectedAgentSlug: string;
  selectedModel: { providerID: string; modelID: string; variant: string };
  getPrompt: () => string;
};

export type LocalSessionCreateOrchestratorState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | {
      phase: 'recovery';
      recovery: LocalSessionCreateRecovery;
      sessionId: string | null;
      requestId: string | null;
      fence: LocalRuntimeFence;
    }
  | { phase: 'navigated' };

export type LocalSessionCreateOrchestrator = {
  submit: () => Promise<LocalSessionCreateOrchestratorState>;
  retry: () => Promise<LocalSessionCreateOrchestratorState>;
  checkAgain: () => Promise<LocalSessionCreateOrchestratorState>;
  getState: () => LocalSessionCreateOrchestratorState;
  subscribe: (listener: (state: LocalSessionCreateOrchestratorState) => void) => () => void;
};

const READINESS_TIMEOUT_MESSAGE = "Session created, but it isn't ready in the app yet.";

export function readinessTimeoutRecovery(): LocalSessionCreateRecovery {
  return { kind: 'readiness-timeout', message: READINESS_TIMEOUT_MESSAGE, ctaLabel: 'Check again' };
}

export async function withInFlightCleared<T>(
  inFlight: { current: Promise<T> | null },
  promise: Promise<T>
): Promise<T> {
  try {
    return await promise;
  } finally {
    if (inFlight.current === promise) {
      inFlight.current = null;
    }
  }
}

export function extractErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return 'Failed to create session';
}

export function requestErrorToRecovery(
  error: LocalSessionCreateRequestError
): LocalSessionCreateRecovery {
  switch (error.code) {
    case 'invalid-agent':
    case 'invalid-catalog':
    case 'invalid-model': {
      return {
        kind: 'catalog-changed',
        message: 'The runtime catalog changed. Review the model and agent, then try again.',
        ctaLabel: 'Refresh catalog',
      };
    }
    case 'invalid-fence': {
      return {
        kind: 'fence-changed',
        message: 'Local runtime disconnected. Select a connected runtime and try again.',
        ctaLabel: 'Select runtime',
      };
    }
    case 'invalid-request-id': {
      return {
        kind: 'transient',
        message: "We couldn't confirm whether the session started. Retry with the same request.",
        ctaLabel: 'Retry',
      };
    }
    case 'invalid-prompt-too-long': {
      return {
        kind: 'non-retryable-prompt-too-long',
        message: error.message,
        ctaLabel: null,
      };
    }
    case 'invalid-prompt-empty': {
      return {
        kind: 'non-retryable-prompt-empty',
        message: error.message,
        ctaLabel: null,
      };
    }
    default: {
      const _exhaustiveCheck: never = error.code;
      void _exhaustiveCheck;
      return {
        kind: 'transient',
        message: error.message,
        ctaLabel: 'Retry',
      };
    }
  }
}
