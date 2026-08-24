import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { getSpawnedAgentSessionPath } from '@/components/agents/session-detail-routes';
import {
  remoteSpawnNonRetryableToast,
  remoteSpawnRetryableToast,
  resolveRemoteSubmitOutcome,
} from '@/lib/remote-submit-outcome';

import { resolveShareDestinationAdmission } from './share-cli-admission';
import {
  selectShareCliSpawnRows,
  type ShareCliSpawnRow,
  shouldCommitShareSpawnReady,
} from './share-cli-spawn';

function instance(
  overrides: Partial<ShareCliSpawnRow> & Pick<ShareCliSpawnRow, 'connectionId'>
): ShareCliSpawnRow {
  return {
    name: 'laptop',
    projectName: 'kilo',
    ...overrides,
  };
}

const ROWS: readonly ShareCliSpawnRow[] = [
  instance({ connectionId: 'conn-1', name: 'MacBook', projectName: 'cloud' }),
  instance({
    connectionId: 'conn-2',
    name: 'Studio',
    projectName: 'mobile',
    capabilities: { attachments: true },
  }),
];

/** Mirrors the gate's appendShareId helper for href construction coverage. */
function appendShareId(base: string, shareId: string): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}shareId=${encodeURIComponent(shareId)}`;
}

describe('selectShareCliSpawnRows', () => {
  it('returns no rows when there are no instances', () => {
    expect(
      selectShareCliSpawnRows({
        instances: [],
        organizationId: null,
        orgLoaded: true,
        gateShowsNewSession: true,
      })
    ).toEqual([]);
  });

  it('returns no rows when an organization id is present', () => {
    expect(
      selectShareCliSpawnRows({
        instances: ROWS,
        organizationId: 'org-1',
        orgLoaded: true,
        gateShowsNewSession: true,
      })
    ).toEqual([]);
  });

  it('returns rows for a personal account once org context is loaded', () => {
    expect(
      selectShareCliSpawnRows({
        instances: ROWS,
        organizationId: null,
        orgLoaded: true,
        gateShowsNewSession: true,
      })
    ).toEqual(ROWS);
  });

  it('returns no rows while org context is still loading (null is not yet personal)', () => {
    expect(
      selectShareCliSpawnRows({
        instances: ROWS,
        organizationId: null,
        orgLoaded: false,
        gateShowsNewSession: true,
      })
    ).toEqual([]);
  });

  it('returns no rows in a terminal gate state (New-session row hidden)', () => {
    expect(
      selectShareCliSpawnRows({
        instances: ROWS,
        organizationId: null,
        orgLoaded: true,
        gateShowsNewSession: false,
      })
    ).toEqual([]);
  });
});

describe('share CLI spawn admission', () => {
  it('refuses a file payload against an instance without attachments', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable: instance({ connectionId: 'c' }).capabilities?.attachments === true,
        hasFiles: true,
      })
    ).toEqual({
      ok: false,
      title: "This session can't receive files",
      message:
        "The Kilo CLI running this session can't receive files. Update the CLI on that machine, or share to a new session instead.",
    });
  });

  it('admits a text-only payload against an instance without attachments', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable: instance({ connectionId: 'c' }).capabilities?.attachments === true,
        hasFiles: false,
      })
    ).toEqual({ ok: true });
  });

  it('admits a file payload when the instance advertises attachments', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable:
          instance({ connectionId: 'c', capabilities: { attachments: true } }).capabilities
            ?.attachments === true,
        hasFiles: true,
      })
    ).toEqual({ ok: true });
  });
});

describe('spawn outcome → action mapping (resolveRemoteSubmitOutcome)', () => {
  const SESSION_ID = 'ses_12345678901234567890123456' as KiloSessionId;
  const CONNECTION_ID = 'conn-1';
  const SHARE_ID = 'share-abc';

  it('maps ready to navigate; gate builds spawned personal href with shareId', () => {
    const action = resolveRemoteSubmitOutcome({
      outcome: { status: 'ready', sessionID: SESSION_ID },
      refetchedInstances: [],
      selectedConnectionId: CONNECTION_ID,
    });
    expect(action).toEqual({ kind: 'navigate', sessionID: SESSION_ID });
    if (action.kind !== 'navigate') {
      return;
    }
    // Gate path: appendShareId(getSpawnedAgentSessionPath(...) as string, shareId)
    // — no organizationId (personal CLI session).
    const href = appendShareId(getSpawnedAgentSessionPath(action.sessionID) as string, SHARE_ID);
    expect(href).toContain(`/agent-chat/${SESSION_ID}`);
    expect(href).toContain('spawned=1');
    expect(href).toContain(`shareId=${SHARE_ID}`);
    expect(href).not.toContain('organizationId');
  });

  it('maps retryable to the retryable toast and refetch flag', () => {
    const action = resolveRemoteSubmitOutcome({
      outcome: { status: 'retryable', reason: 'timeout', cause: new Error('timeout') },
      refetchedInstances: [],
      selectedConnectionId: CONNECTION_ID,
    });
    expect(action).toMatchObject({
      kind: 'retryable',
      toast: remoteSpawnRetryableToast(),
      shouldRefetchInstances: true,
    });
  });

  it('maps nonRetryable to the non-retryable toast without refetch', () => {
    expect(
      resolveRemoteSubmitOutcome({
        outcome: { status: 'nonRetryable', reason: 'upgrade', cause: new Error('upgrade') },
        refetchedInstances: [],
        selectedConnectionId: CONNECTION_ID,
      })
    ).toEqual({ kind: 'nonRetryable', toast: remoteSpawnNonRetryableToast() });
  });
});

describe('shouldCommitShareSpawnReady', () => {
  it('is false when a share already committed (commit race)', () => {
    expect(
      shouldCommitShareSpawnReady({
        committedShareId: 'share-1',
        payloadStillStaged: true,
      })
    ).toBe(false);
  });

  it('is false when the payload was cleared mid-spawn (dismiss/unmount)', () => {
    expect(
      shouldCommitShareSpawnReady({
        committedShareId: null,
        payloadStillStaged: false,
      })
    ).toBe(false);
  });

  it('is true when nothing committed and the payload is still staged', () => {
    expect(
      shouldCommitShareSpawnReady({
        committedShareId: null,
        payloadStillStaged: true,
      })
    ).toBe(true);
  });

  it('is false when both committed and payload already gone', () => {
    expect(
      shouldCommitShareSpawnReady({
        committedShareId: 'share-1',
        payloadStillStaged: false,
      })
    ).toBe(false);
  });
});
