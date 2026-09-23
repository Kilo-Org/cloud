import { describe, expect, it, vi } from 'vitest';

import { type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import {
  areActiveSessionsPayloadsEqual,
  isLiveAgentsSurfaceSegments,
  LIVE_AGENTS_SURFACE_SEGMENTS,
} from '@/lib/active-sessions-floor-poll';

// The module under test imports the React hook stack (react-native AppState,
// the auth context) at module scope; the pure assertions below never run it.
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ authEpoch: 0 }) }));

type Session = CachedActiveSessionsData['sessions'][number];
type AssociatedPr = NonNullable<Session['associatedPr']>;

function makePr(overrides: Partial<AssociatedPr> = {}): AssociatedPr {
  return {
    url: 'https://github.com/Kilo-Org/cloud/pull/1',
    number: 1,
    state: 'open',
    title: 'Reconcile the poll',
    headSha: 'abc123',
    lastSyncedAt: '2026-09-22T10:00:00.000Z',
    reviewDecision: null,
    reviewDecisionPending: false,
    platform: 'github',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-a',
    status: 'running',
    title: 'Fix the jank',
    connectionId: 'connection-1',
    gitUrl: 'https://github.com/Kilo-Org/cloud',
    gitBranch: 'main',
    createdOnPlatform: 'cli',
    createdAt: '2026-09-22T09:00:00.000Z',
    updatedAt: '2026-09-22T09:30:00.000Z',
    lastActivityAt: '2026-09-22T09:30:00.000Z',
    statusUpdatedAt: '2026-09-22T09:30:00.000Z',
    platform: 'darwin',
    totalCostMicrodollars: 1234,
    organizationId: null,
    capabilities: { attachments: true },
    associatedPr: makePr(),
    ...overrides,
  };
}

function payload(sessions: Session[]): CachedActiveSessionsData {
  return { sessions };
}

describe('isLiveAgentsSurfaceSegments', () => {
  it.each(['(0_home)', '(2_agents)', 'share-gate'])(
    'is true for the live-agents segment %s',
    segment => {
      expect(isLiveAgentsSurfaceSegments(['(app)', '(tabs)', segment])).toBe(true);
    }
  );

  it('is true for a nested history route under the Agents tab', () => {
    expect(isLiveAgentsSurfaceSegments(['(app)', '(tabs)', '(2_agents)', 'history'])).toBe(true);
  });

  const nonLiveSurfaceCases: [string, string[]][] = [
    ['kiloclaw tab', ['(app)', '(tabs)', '(1_kiloclaw)']],
    ['profile tab', ['(app)', '(tabs)', '(3_profile)']],
    ['empty segments', []],
  ];
  it.each(nonLiveSurfaceCases)('is false for %s', (_label, segments) => {
    expect(isLiveAgentsSurfaceSegments(segments)).toBe(false);
  });

  it('lists exactly the surfaces documented as live consumers', () => {
    expect([...LIVE_AGENTS_SURFACE_SEGMENTS]).toEqual(['(0_home)', '(2_agents)', 'share-gate']);
  });
});

describe('areActiveSessionsPayloadsEqual', () => {
  it('treats deep-equal payloads as equal', () => {
    expect(areActiveSessionsPayloadsEqual(payload([makeSession()]), payload([makeSession()]))).toBe(
      true
    );
  });

  it('treats the same payload reference as equal', () => {
    const current = payload([makeSession()]);
    expect(areActiveSessionsPayloadsEqual(current, current)).toBe(true);
  });

  it('does not let object key order decide equality', () => {
    const reordered: Session = {
      organizationId: null,
      associatedPr: makePr(),
      capabilities: { attachments: true },
      totalCostMicrodollars: 1234,
      platform: 'darwin',
      statusUpdatedAt: '2026-09-22T09:30:00.000Z',
      lastActivityAt: '2026-09-22T09:30:00.000Z',
      updatedAt: '2026-09-22T09:30:00.000Z',
      createdAt: '2026-09-22T09:00:00.000Z',
      createdOnPlatform: 'cli',
      gitBranch: 'main',
      gitUrl: 'https://github.com/Kilo-Org/cloud',
      connectionId: 'connection-1',
      title: 'Fix the jank',
      status: 'running',
      id: 'session-a',
    };
    expect(areActiveSessionsPayloadsEqual(payload([makeSession()]), payload([reordered]))).toBe(
      true
    );
  });

  it.each([
    ['status', { status: 'idle' }],
    ['title', { title: 'Renamed elsewhere' }],
    ['gitBranch', { gitBranch: 'feat/reconcile' }],
    ['lastActivityAt', { lastActivityAt: '2026-09-22T09:31:00.000Z' }],
    ['totalCostMicrodollars', { totalCostMicrodollars: 4321 }],
  ] as [string, Partial<Session>][])('reports a changed %s as different', (_field, change) => {
    expect(
      areActiveSessionsPayloadsEqual(payload([makeSession()]), payload([makeSession(change)]))
    ).toBe(false);
  });

  it('reports a changed associatedPr.number as different', () => {
    expect(
      areActiveSessionsPayloadsEqual(
        payload([makeSession()]),
        payload([makeSession({ associatedPr: makePr({ number: 2 }) })])
      )
    ).toBe(false);
  });

  it('reports a changed capabilities.attachments as different', () => {
    expect(
      areActiveSessionsPayloadsEqual(
        payload([makeSession()]),
        payload([makeSession({ capabilities: { attachments: false } })])
      )
    ).toBe(false);
  });

  it('reports a dropped associatedPr as different', () => {
    expect(
      areActiveSessionsPayloadsEqual(
        payload([makeSession()]),
        payload([makeSession({ associatedPr: undefined })])
      )
    ).toBe(false);
  });

  it('reports an extra session as different', () => {
    expect(
      areActiveSessionsPayloadsEqual(
        payload([makeSession()]),
        payload([makeSession(), makeSession({ id: 'session-b' })])
      )
    ).toBe(false);
  });

  it('reports a missing session as different', () => {
    expect(
      areActiveSessionsPayloadsEqual(
        payload([makeSession(), makeSession({ id: 'session-b' })]),
        payload([makeSession()])
      )
    ).toBe(false);
  });

  it('reports a reordered array as different', () => {
    const first = makeSession();
    const second = makeSession({ id: 'session-b' });
    expect(areActiveSessionsPayloadsEqual(payload([first, second]), payload([second, first]))).toBe(
      false
    );
  });
});
