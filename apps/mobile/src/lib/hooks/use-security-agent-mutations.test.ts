// Tests for the security-agent mutation hooks and their helpers.
//
// The dashboard owns the sync button and its toasts; the sync suite asserts
// the HOOK WIRING: the `mutationFn` delegates to the matching
// `trpcClient.(organizations.)securityAgent.triggerSync.mutate`, the hoisted
// operation key is merged into the input, and the key rotation policy (real
// `isSecuritySyncRetryable` + `mapSecuritySyncOperationError`) runs inside
// `mutationFn`. Only `useHoistedOperationKey` is mocked (it holds React ref
// state that needs a mounted renderer).
//
// Suites: `useTriggerSecuritySync` wiring, retryability, and reconcile-first
// outbox; `useSaveSecurityAgentConfig` expectedRevision and generation
// guard+scope; `useSetSecurityAgentEnabled` generation guard+scope; `scope.id`
// network serialization (real MutationCache); `securitySyncIntentFingerprint`;
// `isSecuritySyncRetryable`; in-progress copy per surface; and the ledger
// marker copy mapping.
/* eslint-disable max-lines -- one file for the useTriggerSecuritySync wiring/retryability/outbox, useSaveSecurityAgentConfig expectedRevision + generation-guard/scope, useSetSecurityAgentEnabled generation-guard/scope, scope.id serialization (real MutationCache), securitySyncIntentFingerprint, isSecuritySyncRetryable, in-progress copy per surface, and the ledger marker copy mapping suites */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake outbox factories settle without await because they resolve immediately */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ReactQuery from '@tanstack/react-query';

import type * as OperationKeyModule from '@/lib/operation-key';
import {
  isSecuritySyncRetryable,
  mapSecurityDismissOperationError,
  mapSecuritySyncOperationError,
  SECURITY_AMBIGUOUS_MESSAGE,
  SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE,
  SECURITY_LEDGER_SETTLE_FAILED_MESSAGE,
  SECURITY_OPERATION_REPLAY_FAILED_MESSAGE,
  SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE,
  securitySyncIntentFingerprint,
} from '@/lib/security-agent-ledger';
import {
  useSaveSecurityAgentConfig,
  useSetSecurityAgentEnabled,
  useTriggerSecuritySync,
} from './use-security-agent-mutations';
import { reportAppError } from '@/lib/telemetry/app-error-reporting';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

const hoistedKeys = vi.hoisted(() => ({
  getKey: vi.fn(() => 'hoisted-op-key'),
  rotateKey: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/lib/query/schedule-cache-maintenance', () => ({ scheduleCacheMaintenance: vi.fn() }));

vi.mock('@/lib/operation-key', async importOriginal => {
  const actual = await importOriginal<typeof OperationKeyModule>();
  return { ...actual, useHoistedOperationKey: () => hoistedKeys };
});

const outboxMock = vi.hoisted(() => ({
  writeReconcileFirst: vi.fn(async (row: { operationKey: string }) => row.operationKey),
  remove: vi.fn(async (): Promise<void> => undefined),
  whenLoaded: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock('@/lib/persist/use-mutation-outbox', () => ({
  useMutationOutbox: () => outboxMock,
}));

vi.mock('@kilocode/app-shared/security-agent', () => ({
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
}));

vi.mock('@/lib/hooks/use-security-agent-commands', () => ({
  trackSecurityAgentCommand: trackCommandMock,
}));

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onMutate?: (vars: unknown) => Promise<unknown> | unknown;
  onError?: (error: unknown, vars?: unknown, context?: unknown) => void;
  onSuccess?: (result: unknown, vars: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
  scope?: { id: string };
};

let lastCapturedOptions: MutationOptions | null = null;
const personalTriggerSyncMutateMock = vi.fn();
const orgTriggerSyncMutateMock = vi.fn();
const personalSaveConfigMutateMock = vi.fn();
const orgSaveConfigMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const getQueryDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const cancelQueriesMock = vi.fn();
const toastErrorMock = vi.fn();
const trackCommandMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => {
      invalidateQueriesMock(...args);
    },
    getQueryData: (...args: unknown[]) => getQueryDataMock(...args),
    setQueryData: (...args: unknown[]) => setQueryDataMock(...args),
    cancelQueries: (...args: unknown[]) => cancelQueriesMock(...args),
  }),
  hashKey: (key: unknown) => JSON.stringify(key),
  CancelledError: class CancelledError extends Error {},
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    securityAgent: { getConfig: { queryKey: () => ['securityAgent', 'getConfig'] } },
    organizations: {
      securityAgent: {
        getConfig: { queryKey: () => ['organizations', 'securityAgent', 'getConfig'] },
      },
    },
  }),
  trpcClient: {
    securityAgent: {
      triggerSync: { mutate: (vars: unknown) => personalTriggerSyncMutateMock(vars) },
      saveConfig: { mutate: (vars: unknown) => personalSaveConfigMutateMock(vars) },
    },
    organizations: {
      securityAgent: {
        triggerSync: { mutate: (vars: unknown) => orgTriggerSyncMutateMock(vars) },
        saveConfig: { mutate: (vars: unknown) => orgSaveConfigMutateMock(vars) },
      },
    },
  },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: {
    error: (msg: string) => toastErrorMock(msg),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('useTriggerSecuritySync (P1-A-08e wiring)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    personalTriggerSyncMutateMock.mockReset();
    orgTriggerSyncMutateMock.mockReset();
    personalSaveConfigMutateMock.mockReset();
    orgSaveConfigMutateMock.mockReset();
    invalidateQueriesMock.mockReset();
    getQueryDataMock.mockReset();
    setQueryDataMock.mockReset();
    cancelQueriesMock.mockReset();
    toastErrorMock.mockReset();
    trackCommandMock.mockClear();
    hoistedKeys.getKey.mockClear();
    hoistedKeys.rotateKey.mockClear();
    outboxMock.writeReconcileFirst.mockReset();
    outboxMock.writeReconcileFirst.mockImplementation(
      async (row: { operationKey: string }) => row.operationKey
    );
    outboxMock.remove.mockReset();
    outboxMock.remove.mockResolvedValue(undefined);
    outboxMock.whenLoaded.mockReset();
    outboxMock.whenLoaded.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates a personal sync to securityAgent.triggerSync.mutate with the hoisted key', async () => {
    const result = { success: true, accepted: true, commandId: 'cmd-1' };
    personalTriggerSyncMutateMock.mockResolvedValueOnce(result);
    useTriggerSecuritySync('personal');

    await expect(lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })).resolves.toEqual(
      result
    );

    expect(hoistedKeys.getKey).toHaveBeenCalled();
    expect(personalTriggerSyncMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: 'kilo/repo', operationKey: 'hoisted-op-key' })
    );
  });

  it('delegates an org sync to organizations.securityAgent.triggerSync.mutate with the key', async () => {
    orgTriggerSyncMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-2' });
    useTriggerSecuritySync(ORG_ID);

    await lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' });

    expect(orgTriggerSyncMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        repoFullName: 'kilo/repo',
        operationKey: 'hoisted-op-key',
      })
    );
  });

  it('regenerates the key after a successful sync (fresh intent next)', async () => {
    personalTriggerSyncMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-1' });
    useTriggerSecuritySync('personal');

    await lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' });

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto retryable copy', async () => {
    personalTriggerSyncMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({
      message: 'A security sync is already in progress. Please try again.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  // The rest of the retryability matrix is covered by the
  // `isSecuritySyncRetryable` unit tests below; the hook only needs one
  // retryable and one terminal case.
  it('regenerates the key on a non-retryable failure (replay-failed ends the intent)', async () => {
    const replayFailed = new Error('This action did not complete. Please try again.');
    Object.assign(replayFailed, { data: { code: 'BAD_REQUEST' } });
    personalTriggerSyncMutateMock.mockRejectedValueOnce(replayFailed);
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({ message: 'This action did not complete. Please try again.' });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('onError toasts the mapped message through the existing toast path', () => {
    useTriggerSecuritySync('personal');
    lastCapturedOptions?.onError?.(
      mapSecuritySyncOperationError(new Error('operation_in_progress'))
    );
    expect(toastErrorMock).toHaveBeenCalledWith(
      'A security sync is already in progress. Please try again.'
    );
  });

  it('surfaces the in-progress copy and sends no app-error event for it', async () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });
    const server = Object.assign(new Error('operation_in_progress'), {
      name: 'TRPCClientError',
      data: { code: 'CONFLICT', httpStatus: 409 },
    });
    personalTriggerSyncMutateMock.mockRejectedValueOnce(server);
    useTriggerSecuritySync('personal');

    const rejection = await lastCapturedOptions?.mutationFn?.({}).catch((error: unknown) => error);
    // The global MutationCache onError runs this reporter after the hook's onError.
    lastCapturedOptions?.onError?.(rejection);
    reportAppError(rejection, { source: 'mutation' });
    setTelemetrySink(null);

    expect(toastErrorMock).toHaveBeenCalledWith(
      'A security sync is already in progress. Please try again.'
    );
    expect(events).toEqual([]);
  });

  it('onSuccess tracks the accepted command', () => {
    useTriggerSecuritySync('personal');
    lastCapturedOptions?.onSuccess?.(
      { success: true, commandId: 'cmd-9' },
      { repoFullName: 'kilo/repo' }
    );
    expect(trackCommandMock).toHaveBeenCalled();
  });

  it('persists a reconcile-first row before POSTing and removes it on success', async () => {
    personalTriggerSyncMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-1' });
    useTriggerSecuritySync('personal');

    await lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' });

    expect(outboxMock.writeReconcileFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: 'hoisted-op-key',
        fingerprint: expect.any(String),
        scope: 'personal',
      })
    );
    expect(outboxMock.remove).toHaveBeenCalledTimes(1);
    // The row is written before the mutate fires.
    expect(outboxMock.writeReconcileFirst.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      personalTriggerSyncMutateMock.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('awaits the outbox load before writing the reconcile-first row (no key-reuse race)', async () => {
    const order: string[] = [];
    outboxMock.whenLoaded.mockImplementation(async () => {
      order.push('whenLoaded');
      await Promise.resolve();
      return true;
    });
    outboxMock.writeReconcileFirst.mockImplementation(async (row: { operationKey: string }) => {
      order.push('writeReconcileFirst');
      return row.operationKey;
    });
    personalTriggerSyncMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-1' });
    useTriggerSecuritySync('personal');

    await lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' });

    expect(order).toEqual(['whenLoaded', 'writeReconcileFirst']);
  });

  it('keeps the reconcile-first row on a retryable (ambiguous) failure', async () => {
    personalTriggerSyncMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({
      message: 'A security sync is already in progress. Please try again.',
    });
    expect(outboxMock.remove).not.toHaveBeenCalled();
  });

  it('removes the reconcile-first row on a terminal failure', async () => {
    const replayFailed = new Error('This action did not complete. Please try again.');
    Object.assign(replayFailed, { data: { code: 'BAD_REQUEST' } });
    personalTriggerSyncMutateMock.mockRejectedValueOnce(replayFailed);
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({ message: 'This action did not complete. Please try again.' });
    expect(outboxMock.remove).toHaveBeenCalledTimes(1);
  });

  it('re-POSTs with a supplied operationKey on a reconcile retry instead of minting a fresh key', async () => {
    personalTriggerSyncMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-1' });
    useTriggerSecuritySync('personal');

    await lastCapturedOptions?.mutationFn?.({
      repoFullName: 'kilo/repo',
      operationKey: 'stored-op-key',
    });

    expect(hoistedKeys.getKey).not.toHaveBeenCalled();
    expect(personalTriggerSyncMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: 'kilo/repo', operationKey: 'stored-op-key' })
    );
  });
});

describe('useSaveSecurityAgentConfig (expectedRevision)', () => {
  it('sends expectedRevision from the last getConfig on a personal save', async () => {
    getQueryDataMock.mockReturnValue({ configRevision: 7 });
    personalSaveConfigMutateMock.mockResolvedValueOnce({});
    useSaveSecurityAgentConfig('personal');

    await lastCapturedOptions?.mutationFn?.({ slaEnabled: true });

    expect(personalSaveConfigMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 7 })
    );
  });

  it('sends expectedRevision null when no config is cached', async () => {
    getQueryDataMock.mockReturnValue(undefined);
    personalSaveConfigMutateMock.mockResolvedValueOnce({});
    useSaveSecurityAgentConfig('personal');

    await lastCapturedOptions?.mutationFn?.({ slaEnabled: true });

    expect(personalSaveConfigMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: null })
    );
  });
});

describe('useSaveSecurityAgentConfig (generation guard + scope)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    getQueryDataMock.mockReset();
    setQueryDataMock.mockReset();
    cancelQueriesMock.mockReset();
    toastErrorMock.mockReset();
  });

  it('scopes the mutation to serialize against a toggle on the same config', () => {
    useSaveSecurityAgentConfig('personal');
    expect(lastCapturedOptions?.scope).toEqual({ id: 'security-agent-config:personal' });
  });

  it('a failing older save does not roll back while a newer save owns the config', async () => {
    getQueryDataMock.mockReturnValue({ isEnabled: false, slaEnabled: false });
    useSaveSecurityAgentConfig('personal');
    const older = await lastCapturedOptions?.onMutate?.({ slaEnabled: true });
    const newer = await lastCapturedOptions?.onMutate?.({ slaEnabled: false });

    setQueryDataMock.mockClear();
    lastCapturedOptions?.onError?.(new Error('boom'), { slaEnabled: true }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();

    lastCapturedOptions?.onError?.(new Error('boom'), { slaEnabled: false }, newer);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    // The toast fires regardless of which generation failed.
    expect(toastErrorMock).toHaveBeenCalledTimes(2);
  });

  it('a failing latest save rolls back its snapshot', async () => {
    getQueryDataMock.mockReturnValue({ isEnabled: false, slaEnabled: false });
    useSaveSecurityAgentConfig('personal');
    const context = await lastCapturedOptions?.onMutate?.({ slaEnabled: true });

    setQueryDataMock.mockClear();
    lastCapturedOptions?.onError?.(new Error('boom'), { slaEnabled: true }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});

describe('useSetSecurityAgentEnabled (generation guard + scope)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    getQueryDataMock.mockReset();
    setQueryDataMock.mockReset();
    cancelQueriesMock.mockReset();
    toastErrorMock.mockReset();
  });

  it('scopes the mutation to serialize against a save on the same config', () => {
    useSetSecurityAgentEnabled('personal');
    expect(lastCapturedOptions?.scope).toEqual({ id: 'security-agent-config:personal' });
  });

  it('a failing older toggle does not roll back while a newer toggle owns the config', async () => {
    getQueryDataMock.mockReturnValue({ isEnabled: false, configRevision: 1 });
    useSetSecurityAgentEnabled('personal');
    const older = await lastCapturedOptions?.onMutate?.({ isEnabled: true });
    const newer = await lastCapturedOptions?.onMutate?.({ isEnabled: false });

    setQueryDataMock.mockClear();
    lastCapturedOptions?.onError?.(new Error('boom'), { isEnabled: true }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();

    lastCapturedOptions?.onError?.(new Error('boom'), { isEnabled: false }, newer);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledTimes(2);
  });

  it('a failing latest toggle rolls back its snapshot', async () => {
    getQueryDataMock.mockReturnValue({ isEnabled: false, configRevision: 1 });
    useSetSecurityAgentEnabled('personal');
    const context = await lastCapturedOptions?.onMutate?.({ isEnabled: true });

    setQueryDataMock.mockClear();
    lastCapturedOptions?.onError?.(new Error('boom'), { isEnabled: true }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});

describe('scope.id network serialization (real MutationCache)', () => {
  it('starts the second same-scope mutationFn only after the first settles', async () => {
    const { MutationCache, QueryClient } =
      await vi.importActual<typeof ReactQuery>('@tanstack/react-query');
    const cache = new MutationCache();
    const client = new QueryClient({ mutationCache: cache });
    const order: string[] = [];
    const gate = Promise.withResolvers<null>();

    const first = cache.build(client, {
      mutationFn: async () => {
        order.push('first-start');
        await gate.promise;
        order.push('first-end');
        return 'first';
      },
      scope: { id: 'security-agent-config:personal' },
    });
    const second = cache.build(client, {
      mutationFn: async () => {
        order.push('second-start');
        return 'second';
      },
      scope: { id: 'security-agent-config:personal' },
    });

    const p1 = first.execute({});
    const p2 = second.execute({});
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    gate.resolve(null);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});

describe('securitySyncIntentFingerprint (P1-A-08e changed-input)', () => {
  it('stays stable for a retry of the same scope+repo and rotates when the repo or scope changes', () => {
    const original = securitySyncIntentFingerprint(ORG_ID, 'kilo/repo');
    expect(securitySyncIntentFingerprint(ORG_ID, 'kilo/repo')).toBe(original);

    expect(securitySyncIntentFingerprint(ORG_ID, 'kilo/other')).not.toBe(original);
    expect(securitySyncIntentFingerprint(ORG_ID, undefined)).not.toBe(original);
    expect(securitySyncIntentFingerprint('personal', 'kilo/repo')).not.toBe(original);
  });
});

describe('isSecuritySyncRetryable (P1-A-08e key-rotation policy)', () => {
  it('keeps the key on retryable ledger outcomes (in-progress, ambiguous, settle-failed)', () => {
    expect(isSecuritySyncRetryable(new Error('operation_in_progress'))).toBe(true);
    expect(
      isSecuritySyncRetryable(
        new Error("Couldn't confirm — check the security review before retrying.")
      )
    ).toBe(true);
    expect(
      isSecuritySyncRetryable(
        new Error('The action completed, but we could not record the result. Please try again.')
      )
    ).toBe(true);
  });

  it('keeps the key on generic retryable failures', () => {
    expect(isSecuritySyncRetryable(new Error('Network request failed'))).toBe(true);
  });

  it('regenerates the key on non-retryable markers and typed rejections', () => {
    expect(
      isSecuritySyncRetryable(new Error('We could not record this action. Please try again later.'))
    ).toBe(false);
    expect(isSecuritySyncRetryable(new Error('operation_key_reuse_mismatch'))).toBe(false);
    const replayFailed = new Error('This action did not complete. Please try again.');
    Object.assign(replayFailed, { data: { code: 'BAD_REQUEST' } });
    expect(isSecuritySyncRetryable(replayFailed)).toBe(false);
    const forbidden = new Error('no permission');
    Object.assign(forbidden, { data: { code: 'FORBIDDEN' } });
    expect(isSecuritySyncRetryable(forbidden)).toBe(false);
    const repoUnknown = new Error('Repository not found in your GitHub integration');
    Object.assign(repoUnknown, { data: { code: 'PRECONDITION_FAILED' } });
    expect(isSecuritySyncRetryable(repoUnknown)).toBe(false);
  });

  it('treats the missing-configuration rejection as non-retryable by message and by code', () => {
    const byMessage = new Error(SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE);
    expect(isSecuritySyncRetryable(byMessage)).toBe(false);

    const byCode = new Error('Security service is not configured');
    Object.assign(byCode, { data: { code: 'PRECONDITION_FAILED' } });
    expect(isSecuritySyncRetryable(byCode)).toBe(false);
  });
});

describe('ledger marker copy per surface', () => {
  it('maps the in-progress marker onto each surface copy', () => {
    expect(mapSecuritySyncOperationError(new Error('operation_in_progress'))).toMatchObject({
      message: 'A security sync is already in progress. Please try again.',
    });
    expect(mapSecurityDismissOperationError(new Error('operation_in_progress'))).toMatchObject({
      message: 'This dismissal is already in progress. Please try again.',
    });
  });

  it('maps every ledger marker onto its copy and keeps its retryability', () => {
    const cases = [
      [
        SECURITY_AMBIGUOUS_MESSAGE,
        "Couldn't confirm — check the security review before retrying.",
        true,
      ],
      [
        SECURITY_LEDGER_SETTLE_FAILED_MESSAGE,
        'The action completed, but we could not record the result. Please try again.',
        true,
      ],
      [
        SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE,
        'We could not record this action. Please try again later.',
        false,
      ],
      [
        SECURITY_OPERATION_REPLAY_FAILED_MESSAGE,
        'This action did not complete. Please try again.',
        false,
      ],
    ] as const;
    for (const [marker, copy, retryable] of cases) {
      const mapped = mapSecuritySyncOperationError(new Error(marker));
      expect(mapped.message).toBe(copy);
      expect(isSecuritySyncRetryable(mapped)).toBe(retryable);
    }
  });

  it('maps the missing-configuration rejection onto its copy, still non-retryable', () => {
    const mapped = mapSecuritySyncOperationError(
      new Error(SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE)
    );
    expect(mapped.message).toBe(
      'Security service is not configured. Resubmitting cannot succeed until this is fixed.'
    );
    expect(isSecuritySyncRetryable(mapped)).toBe(false);
  });

  it('maps an unrecognised message onto the generic copy and carries its retryability', () => {
    const transport = mapSecuritySyncOperationError(new Error('Network request failed'));
    expect(transport.message).toBe('Could not complete this action. Please try again.');
    expect(isSecuritySyncRetryable(transport)).toBe(true);

    const forbidden = Object.assign(new Error('no permission'), {
      data: { code: 'FORBIDDEN' },
    });
    const mappedForbidden = mapSecurityDismissOperationError(forbidden);
    expect(mappedForbidden.message).toBe(
      'Could not complete this action. The problem needs fixing before you can retry.'
    );
    expect(isSecuritySyncRetryable(mappedForbidden)).toBe(false);
  });
});
