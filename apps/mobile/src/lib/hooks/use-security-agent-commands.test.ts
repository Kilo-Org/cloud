// P1-G-51b unit tests for the bounded batch observer's pure helpers: the
// 100-id slice, the procedure-missing fallback signature, the active-only
// poll interval, the terminal reconciliation (omission-equals-NOT_FOUND), and
// the push invalidation target. The hook wiring (enabled gating, no
// conditional hook call, reconnect defaults) is asserted in the mounted test.
import { describe, expect, it, vi } from 'vitest';

import {
  activeCommandPollInterval,
  invalidateSecurityAgentCommandObserver,
} from './use-security-agent-commands';
import {
  BATCH_COMMAND_LIMIT,
  isMissingBatchProcedureError,
  reconcileCommandStatuses,
  type SecurityCommand,
  splitTrackedCommandIds,
} from '@/lib/security-agent';

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({}),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

function makeCommand(overrides: Partial<SecurityCommand> = {}): SecurityCommand {
  return {
    id: 'cmd-1',
    commandType: 'sync',
    origin: 'manual',
    findingId: null,
    repoFullName: null,
    status: 'accepted',
    resultCode: null,
    resultMetadata: null,
    lastErrorRedacted: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `id-${i}`);
}

function trpcError(code: string, message: string): unknown {
  return { message, data: { code } };
}

type InvalidationTrpcStub = {
  securityAgent: {
    getCommandStatuses: { queryKey: () => string[] };
    listActiveCommands: { queryKey: () => string[] };
  };
  organizations: {
    securityAgent: {
      getCommandStatuses: { queryKey: () => string[] };
      listActiveCommands: { queryKey: () => string[] };
    };
  };
};

function makeTrpcStub(): InvalidationTrpcStub {
  return {
    securityAgent: {
      getCommandStatuses: { queryKey: () => ['securityAgent', 'getCommandStatuses'] },
      listActiveCommands: { queryKey: () => ['securityAgent', 'listActiveCommands'] },
    },
    organizations: {
      securityAgent: {
        getCommandStatuses: {
          queryKey: () => ['organizations', 'securityAgent', 'getCommandStatuses'],
        },
        listActiveCommands: {
          queryKey: () => ['organizations', 'securityAgent', 'listActiveCommands'],
        },
      },
    },
  };
}

describe('splitTrackedCommandIds (100-id slice)', () => {
  it('slices the first 100 ids into the batch and the rest into overflow', () => {
    const { batchIds, overflowIds } = splitTrackedCommandIds(makeIds(150));

    expect(batchIds).toHaveLength(BATCH_COMMAND_LIMIT);
    expect(overflowIds).toHaveLength(50);
    expect(batchIds.at(0)).toBe('id-0');
    expect(batchIds.at(99)).toBe('id-99');
    expect(overflowIds.at(0)).toBe('id-100');
    expect(overflowIds.at(49)).toBe('id-149');
  });

  it('returns an empty overflow slice for 100 or fewer ids', () => {
    expect(splitTrackedCommandIds([])).toEqual({ batchIds: [], overflowIds: [] });

    const { batchIds, overflowIds } = splitTrackedCommandIds(['a', 'b']);
    expect(batchIds).toEqual(['a', 'b']);
    expect(overflowIds).toEqual([]);
  });
});

describe('isMissingBatchProcedureError (fallback signature)', () => {
  it('engages only on the procedure-missing NOT_FOUND signature', () => {
    expect(
      isMissingBatchProcedureError(
        trpcError('NOT_FOUND', 'No "query"-procedure on path "securityAgent.getCommandStatuses"')
      )
    ).toBe(true);
  });

  it('rejects a bare NOT_FOUND (the per-command purge path)', () => {
    expect(
      isMissingBatchProcedureError(trpcError('NOT_FOUND', 'Security Agent command not found'))
    ).toBe(false);
  });

  it('rejects a non-NOT_FOUND code even with the procedure-missing message', () => {
    expect(
      isMissingBatchProcedureError(
        trpcError('INTERNAL_SERVER_ERROR', 'No "query"-procedure on path "x"')
      )
    ).toBe(false);
  });

  it('rejects non-tRPC errors and empty values', () => {
    expect(isMissingBatchProcedureError(new Error('Network request failed'))).toBe(false);
    expect(isMissingBatchProcedureError(null)).toBe(false);
    expect(isMissingBatchProcedureError(undefined)).toBe(false);
  });
});

describe('activeCommandPollInterval (no polling with no active commands)', () => {
  it('returns false for an empty or absent result', () => {
    expect(activeCommandPollInterval(undefined)).toBe(false);
    expect(activeCommandPollInterval([])).toBe(false);
  });

  it('returns false when every returned command is terminal', () => {
    expect(activeCommandPollInterval([makeCommand({ status: 'succeeded' })])).toBe(false);
    expect(activeCommandPollInterval([makeCommand({ status: 'failed' })])).toBe(false);
  });

  it('returns the 3s interval while any returned command is active', () => {
    expect(activeCommandPollInterval([makeCommand({ status: 'accepted' })])).toBe(3000);
    expect(
      activeCommandPollInterval([
        makeCommand({ status: 'succeeded' }),
        makeCommand({ id: 'cmd-2', status: 'running' }),
      ])
    ).toBe(3000);
  });
});

describe('reconcileCommandStatuses (terminal + omission purge)', () => {
  const processed = new Set<string>();

  it('collects a terminal command once', () => {
    const terminal = makeCommand({ id: 'cmd-1', status: 'succeeded' });
    const result = reconcileCommandStatuses({
      trackedIds: ['cmd-1'],
      batchIds: ['cmd-1'],
      perCommandIds: [],
      batchCommands: [terminal],
      batchSettled: true,
      perCommandResults: [],
      processedTerminalIds: processed,
    });

    expect(result.terminalCommands).toEqual([terminal]);
    expect(result.unavailableIds).toEqual([]);
  });

  it('skips a terminal command whose id is already processed (no second toast)', () => {
    const result = reconcileCommandStatuses({
      trackedIds: ['cmd-1'],
      batchIds: ['cmd-1'],
      perCommandIds: [],
      batchCommands: [makeCommand({ id: 'cmd-1', status: 'succeeded' })],
      batchSettled: true,
      perCommandResults: [],
      processedTerminalIds: new Set(['cmd-1']),
    });

    expect(result.terminalCommands).toEqual([]);
    expect(result.unavailableIds).toEqual([]);
  });

  it('does not drop an already-processed id the settled batch omitted', () => {
    const result = reconcileCommandStatuses({
      trackedIds: ['cmd-1'],
      batchIds: ['cmd-1'],
      perCommandIds: [],
      batchCommands: [],
      batchSettled: true,
      perCommandResults: [],
      processedTerminalIds: new Set(['cmd-1']),
    });

    expect(result.unavailableIds).toEqual([]);
    expect(result.terminalCommands).toEqual([]);
  });

  it('purges a batch id the settled batch omitted (omission-equals-NOT_FOUND)', () => {
    const result = reconcileCommandStatuses({
      trackedIds: ['cmd-1', 'cmd-2'],
      batchIds: ['cmd-1', 'cmd-2'],
      perCommandIds: [],
      batchCommands: [makeCommand({ id: 'cmd-1', status: 'accepted' })],
      batchSettled: true,
      perCommandResults: [],
      processedTerminalIds: processed,
    });

    expect(result.unavailableIds).toEqual(['cmd-2']);
    expect(result.terminalCommands).toEqual([]);
  });

  it('does not purge a batch id while the batch is still loading', () => {
    const result = reconcileCommandStatuses({
      trackedIds: ['cmd-1'],
      batchIds: ['cmd-1'],
      perCommandIds: [],
      batchCommands: undefined,
      batchSettled: false,
      perCommandResults: [],
      processedTerminalIds: processed,
    });

    expect(result.unavailableIds).toEqual([]);
  });

  it('purges an overflow id only when its per-command query is NOT_FOUND', () => {
    const result = reconcileCommandStatuses({
      trackedIds: ['cmd-100', 'cmd-101'],
      batchIds: ['cmd-100'],
      perCommandIds: ['cmd-101'],
      batchCommands: [makeCommand({ id: 'cmd-100', status: 'accepted' })],
      batchSettled: true,
      perCommandResults: [{ error: { data: { code: 'NOT_FOUND' } } }],
      processedTerminalIds: processed,
    });

    expect(result.unavailableIds).toEqual(['cmd-101']);
  });

  it('keeps a loading overflow id and a terminal overflow command', () => {
    const terminal = makeCommand({ id: 'cmd-101', status: 'failed' });
    const result = reconcileCommandStatuses({
      trackedIds: ['cmd-100', 'cmd-101', 'cmd-102'],
      batchIds: ['cmd-100'],
      perCommandIds: ['cmd-101', 'cmd-102'],
      batchCommands: [makeCommand({ id: 'cmd-100', status: 'accepted' })],
      batchSettled: true,
      perCommandResults: [{ data: terminal }, {}],
      processedTerminalIds: processed,
    });

    expect(result.terminalCommands).toEqual([terminal]);
    expect(result.unavailableIds).toEqual([]);
  });
});

describe('invalidateSecurityAgentCommandObserver (push hint)', () => {
  it('invalidates the personal batch and active-command queries', () => {
    const invalidateQueries = vi.fn();
    const queryClient = { invalidateQueries };

    invalidateSecurityAgentCommandObserver(
      queryClient as never,
      makeTrpcStub() as never,
      'personal'
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['securityAgent', 'getCommandStatuses'],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['securityAgent', 'listActiveCommands'],
    });
  });

  it('invalidates the organization batch and active-command queries', () => {
    const invalidateQueries = vi.fn();
    const queryClient = { invalidateQueries };

    invalidateSecurityAgentCommandObserver(queryClient as never, makeTrpcStub() as never, 'org_1');

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['organizations', 'securityAgent', 'getCommandStatuses'],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['organizations', 'securityAgent', 'listActiveCommands'],
    });
  });
});
