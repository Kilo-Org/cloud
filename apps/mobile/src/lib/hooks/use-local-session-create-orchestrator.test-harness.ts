import { vi } from 'vitest';

import {
  buildLocalSessionCreateRequest,
  type BuiltLocalSessionCreateRequest,
} from './local-session-create-request';
import { createLocalSessionRequestIdStore, type RequestIdUuid } from './local-session-request-id';
import { type LocalSessionCreateOrchestratorDeps } from './use-local-session-create-orchestrator';

type OrchestratorCallTrace = {
  createAndRun: { fence: { runtimeId: string; connectionId: string }; requestId: string }[];
  pollReadiness: { sessionId: string }[];
  navigate: { path: string }[];
  invalidateCalls: number;
  captureEvent: { name: string; properties: Record<string, unknown> | undefined }[];
  haptic: ('success' | 'warning' | 'error')[];
  showError: { message: string }[];
  showInfo: { message: string }[];
};

export const SESSION_ID = 'sess-abc';

export const REQUEST_ID_1: RequestIdUuid = '00000000-0000-4000-8000-000000000001' as RequestIdUuid;
export const REQUEST_ID_2: RequestIdUuid = '00000000-0000-4000-8000-000000000002' as RequestIdUuid;

export type CreateAndRunSpy = ReturnType<typeof vi.fn>;
type PollReadinessSpy = ReturnType<typeof vi.fn>;
type SleepSpy = ReturnType<typeof vi.fn>;
type InvalidateCachesSpy = ReturnType<typeof vi.fn>;

type MakeDepsOverrides = Partial<LocalSessionCreateOrchestratorDeps> & {
  requestIds?: RequestIdUuid[];
};

type MakeDepsResult = {
  deps: LocalSessionCreateOrchestratorDeps;
  trace: OrchestratorCallTrace;
  createAndRunImpl: CreateAndRunSpy;
  pollReadinessImpl: PollReadinessSpy;
  sleepImpl: SleepSpy;
  requestIdIndex: { value: number };
  invalidateCachesImpl: InvalidateCachesSpy;
};

export function makeDeps(overrides: MakeDepsOverrides = {}): MakeDepsResult {
  const trace: OrchestratorCallTrace = {
    createAndRun: [],
    pollReadiness: [],
    navigate: [],
    invalidateCalls: 0,
    captureEvent: [],
    haptic: [],
    showError: [],
    showInfo: [],
  };
  const requestIds = overrides.requestIds ?? [];
  const requestIdIndex = { value: 0 };
  const createAndRunImpl = vi.fn();
  const pollReadinessImpl = vi.fn();
  const sleepImpl = vi.fn().mockResolvedValue(undefined);
  const invalidateCachesImpl = vi.fn();

  const deps: LocalSessionCreateOrchestratorDeps = {
    requestIdStore: createLocalSessionRequestIdStore({
      generateUuid: () => {
        const id = requestIds[requestIdIndex.value] ?? REQUEST_ID_1;
        requestIdIndex.value += 1;
        return id;
      },
    }),
    buildRequest: (input: Parameters<LocalSessionCreateOrchestratorDeps['buildRequest']>[0]) =>
      buildLocalSessionCreateRequest(input),
    createAndRun: ((input: BuiltLocalSessionCreateRequest) => {
      trace.createAndRun.push({ fence: input.fence, requestId: input.request.requestId });
      return createAndRunImpl(input);
    }) as LocalSessionCreateOrchestratorDeps['createAndRun'],
    pollReadiness: ((input: { sessionId: string }) => {
      trace.pollReadiness.push({ sessionId: input.sessionId });
      return pollReadinessImpl(input);
    }) as LocalSessionCreateOrchestratorDeps['pollReadiness'],
    sleep: sleepImpl as LocalSessionCreateOrchestratorDeps['sleep'],
    invalidateCaches: (async () => {
      trace.invalidateCalls += 1;
      await invalidateCachesImpl();
    }) as LocalSessionCreateOrchestratorDeps['invalidateCaches'],
    captureEvent: (name, properties) => {
      trace.captureEvent.push({ name, properties });
    },
    notificationHaptic: kind => {
      trace.haptic.push(kind);
    },
    navigate: path => {
      trace.navigate.push({ path });
    },
    showError: message => {
      trace.showError.push({ message });
    },
    showInfo: message => {
      trace.showInfo.push({ message });
    },
    pollIntervalMs: 500,
    pollMaxMs: 15_000,
    ...overrides,
  };
  return {
    deps,
    trace,
    createAndRunImpl,
    pollReadinessImpl,
    sleepImpl,
    requestIdIndex,
    invalidateCachesImpl,
  };
}
