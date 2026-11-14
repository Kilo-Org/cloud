import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type KiloSdkMessageHistoryPage,
  type KiloSessionId,
  type PreparationAttempt,
} from '@kilocode/cloud-agent-sdk';

const mocks = vi.hoisted(() => ({
  getSessionMessagesPageQuery: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cliSessionsV2: {
      getSessionMessagesPage: { query: mocks.getSessionMessagesPageQuery },
    },
  },
}));

function kiloSessionId(id: string): KiloSessionId {
  return id as KiloSessionId;
}

function historyPage(
  overrides: Partial<KiloSdkMessageHistoryPage> = {}
): KiloSdkMessageHistoryPage {
  return { messages: [], nextCursor: null, omittedItemCount: 0, ...overrides };
}

/** The row a run whose sandbox preparation failed carries, with no messages. */
function failedPreparationAttempt(): PreparationAttempt {
  return {
    id: 'attempt-1',
    triggerMessageId: 'msg_user_01',
    status: 'failed',
    startedAt: 0,
    completedAt: 1,
    safeError: 'invalid_configuration',
    revision: 2,
    steps: [
      {
        id: 'step-sandbox',
        key: 'sandbox_provision',
        kind: 'phase',
        label: 'sandbox provision',
        status: 'failed',
        startedAt: 0,
        completedAt: 1,
        revision: 1,
        latestDetail: 'Creating sandbox',
        safeError: 'invalid_configuration',
      },
    ],
  };
}

// The adapter is imported after `vi.mock` runs, so its `@/lib/trpc` import
// resolves to the mock; a static import would bind before the mock exists.
async function fetchPage(id: KiloSessionId): Promise<Record<string, unknown>> {
  const { fetchMobileSessionSnapshotPage } =
    await import('@/components/agents/mobile-session-page-adapter');
  return (await fetchMobileSessionSnapshotPage(id, {})) as Record<string, unknown>;
}

describe('mobile session page preparation rows', () => {
  beforeEach(() => {
    mocks.getSessionMessagesPageQuery.mockReset();
  });

  // A run whose sandbox preparation failed has no messages at all, so the
  // preparation rows are the only thing the open can show. Both success arms
  // carry them; the SDK restores the rows from the page before the first paint.
  it('carries the preparation rows of a message page', async () => {
    const attempt = failedPreparationAttempt();
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: historyPage(),
      watermarkEventId: 7,
      preparationAttempts: [attempt],
    });

    await expect(fetchPage(kiloSessionId('ses_123'))).resolves.toMatchObject({
      kind: 'success',
      watermarkEventId: 7,
      preparationAttempts: [attempt],
    });
  });

  it('carries the preparation rows of a null history page', async () => {
    const attempt = failedPreparationAttempt();
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_failed_open',
      history: null,
      preparationAttempts: [attempt],
    });

    await expect(fetchPage(kiloSessionId('ses_failed_open'))).resolves.toMatchObject({
      kind: 'success',
      messages: [],
      preparationAttempts: [attempt],
    });
  });

  it('omits the preparation field when the router sends no rows', async () => {
    // Absent means the page cannot vouch for the rows: the SDK's restore keeps
    // the live ones instead of clearing them on every page read.
    const outcomes = await Promise.all(
      [undefined, []].map(preparationAttempts => {
        mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
          kiloSessionId: 'ses_123',
          history: historyPage(),
          ...(preparationAttempts === undefined ? {} : { preparationAttempts }),
        });
        return fetchPage(kiloSessionId('ses_123'));
      })
    );

    for (const outcome of outcomes) {
      expect(outcome).not.toHaveProperty('preparationAttempts');
    }
  });
});
