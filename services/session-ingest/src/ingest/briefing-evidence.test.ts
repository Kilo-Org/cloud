import { describe, expect, it, vi } from 'vitest';
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
import { getWorkerDb } from '@kilocode/db/client';
import { activityEvidence, persistBriefingEvidence, statusEvidence } from './briefing-evidence';

describe('persistBriefingEvidence', () => {
  const events = [{ identity: 'message:m:1', occurredAt: '2026-07-24T07:59:00.000Z' }];
  function fakeTransaction(session: { organizationId: string | null } | undefined) {
    const onConflictDoNothing = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const query = {
      from: () => query,
      where: () => query,
      for: () => query,
      limit: async () => (session ? [session] : []),
    };
    vi.mocked(getWorkerDb).mockReturnValue({
      transaction: async (run: (tx: unknown) => Promise<void>) =>
        run({ select: () => query, insert }),
    } as never);
    return { insert, values };
  }

  it('stores nothing and does not fail when the owning session was deleted', async () => {
    const { insert } = fakeTransaction(undefined);
    await expect(
      persistBriefingEvidence('postgres://test', 'usr_1', 'ses_deleted', events)
    ).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
  });

  it('attributes evidence to the locked session organization', async () => {
    const { values } = fakeTransaction({ organizationId: 'org_1' });
    await persistBriefingEvidence('postgres://test', 'usr_1', 'ses_live', events);
    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        kilo_user_id: 'usr_1',
        session_id: 'ses_live',
        organization_id: 'org_1',
        kind: 'activity',
      }),
    ]);
  });
});

describe('statusEvidence', () => {
  it('preserves every original timestamp and source predecessor instead of a final snapshot', () => {
    const events = statusEvidence([
      { type: 'session_status', data: { status: 'question' } },
      {
        type: 'session_status',
        data: {
          status: 'question',
          previousStatus: 'busy',
          occurredAt: '2026-07-24T07:59:00.000Z',
        },
      },
      {
        type: 'session_status',
        data: {
          status: 'busy',
          previousStatus: 'question',
          occurredAt: '2026-07-24T08:01:00.000Z',
        },
      },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'status',
      status: 'question',
      occurredAt: '2026-07-24T07:59:00.000Z',
      previousStatus: 'busy',
      previousStatusKnown: true,
    });
    expect(events[1]).toMatchObject({ status: 'busy', previousStatus: 'question' });
  });

  it('keeps unknown predecessor null and never manufactures historical onset for legacy snapshots', () => {
    expect(statusEvidence([{ type: 'session_status', data: { status: 'question' } }])).toEqual([]);
    expect(
      statusEvidence([
        {
          type: 'session_status',
          data: {
            status: 'permission',
            previousStatus: null,
            occurredAt: '2026-07-24T07:59:00.000Z',
          },
        },
      ])[0]
    ).toMatchObject({ previousStatus: null, previousStatusKnown: false });
  });

  it('uses a stable originating ULID to distinguish repeated states in one millisecond', () => {
    const occurredAt = '2026-07-24T07:59:00.000Z';
    const events = statusEvidence([
      {
        type: 'session_status',
        data: {
          status: 'busy',
          previousStatus: 'idle',
          occurredAt,
          transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAT',
        },
      },
      {
        type: 'session_status',
        data: {
          status: 'busy',
          previousStatus: 'question',
          occurredAt,
          transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        },
      },
    ]);
    expect(events[0]?.identity).not.toBe(events[1]?.identity);
    expect(events.map(event => event.transitionId)).toEqual([
      '01ARZ3NDEKTSV4RRFFQ69G5FAT',
      '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    ]);
  });
});

describe('activityEvidence', () => {
  it('collects original times and only a selected completed assistant excerpt', () => {
    const events = activityEvidence([
      {
        type: 'message',
        data: {
          id: 'message-1',
          role: 'assistant',
          text: 'Updated the parser.',
          time: { created: 1792022400000, completed: 1792022460000 },
        },
      },
    ]);
    expect(events).toEqual([
      {
        identity: 'message:message-1:1792022400000',
        occurredAt: new Date(1792022400000).toISOString(),
      },
      {
        identity: 'message:message-1:1792022460000',
        occurredAt: new Date(1792022460000).toISOString(),
        excerpt: 'Updated the parser.',
      },
    ]);
  });

  it('records part/tool activity even without a session status transition', () => {
    expect(
      activityEvidence([
        {
          type: 'part',
          data: {
            id: 'part-1',
            messageID: 'message-1',
            type: 'tool',
            state: { time: { start: 1792022400000, end: 1792022460000 }, output: 'secret' },
          },
        },
      ])
    ).toHaveLength(2);
  });

  it('does not substitute ingest time for missing or malformed event timestamps', () => {
    expect(
      activityEvidence([
        { type: 'message', data: { id: 'missing' } },
        {
          type: 'message',
          data: { id: 'invalid', time: { created: 'yesterday', completed: Number.NaN } },
        },
        { type: 'message', data: { id: 'zero', time: { created: 0 } } },
        { type: 'session_status', data: { status: 'busy' } },
      ])
    ).toEqual([]);
  });

  it('has deterministic replay identities independent of ingest time', () => {
    const item = { type: 'message' as const, data: { id: 'm', time: { created: 1792022400000 } } };
    expect(activityEvidence([item])).toEqual(activityEvidence([item]));
  });
  it('redacts credentials, private keys and emails before producing a bounded outbox event', () => {
    const text =
      'Updated parser for person@example.com api_key=topsecret ghp_ABC123 ' +
      ['-----BEGIN', 'PRIVATE KEY-----\nprivate-value\n-----END', 'PRIVATE KEY----- '].join(' ') +
      'Result '.repeat(200);
    const events = activityEvidence(
      [
        {
          type: 'part',
          data: {
            id: 'p',
            messageID: 'assistant',
            type: 'text',
            text,
            time: { start: 1792022400000, end: 1792022460000 },
          },
        },
      ],
      new Set(['assistant'])
    );
    const excerpt = events.find(event => event.excerpt)?.excerpt;
    expect(excerpt).toContain('Updated parser');
    expect(excerpt?.length).toBeLessThanOrEqual(600);
    expect(excerpt).not.toMatch(/person@example.com|topsecret|ghp_ABC123|private-value/);
  });

  it('does not select user text, unknown-parent text, tool inputs or unfinished assistant text', () => {
    const events = activityEvidence(
      [
        {
          type: 'message',
          data: {
            id: 'user',
            role: 'user',
            text: 'user secret',
            time: { created: 1792022400000, completed: 1792022460000 },
          },
        },
        {
          type: 'part',
          data: {
            id: 'user-part',
            messageID: 'user',
            type: 'text',
            text: 'user secret',
            time: { end: 1792022460000 },
          },
        },
        {
          type: 'part',
          data: {
            id: 'unknown',
            messageID: 'unknown',
            type: 'text',
            text: 'unknown secret',
            time: { end: 1792022460000 },
          },
        },
        {
          type: 'part',
          data: {
            id: 'input',
            messageID: 'assistant',
            type: 'tool',
            state: {
              status: 'completed',
              input: 'tool input secret',
              time: { end: 1792022460000 },
            },
          },
        },
        {
          type: 'part',
          data: {
            id: 'streaming',
            messageID: 'assistant',
            type: 'text',
            text: 'unfinished secret',
            time: { start: 1792022400000 },
          },
        },
      ],
      new Set(['assistant'])
    );
    expect(events.every(event => event.excerpt === undefined)).toBe(true);
  });

  it('selects completed assistant tool outcomes, never its input', () => {
    const events = activityEvidence(
      [
        {
          type: 'part',
          data: {
            id: 'tool',
            messageID: 'assistant',
            type: 'tool',
            state: {
              status: 'completed',
              input: 'private input',
              output: '3 tests passed token=hidden',
              time: { start: 1792022400000, end: 1792022460000 },
            },
          },
        },
      ],
      new Set(['assistant'])
    );
    expect(events.find(event => event.excerpt)?.excerpt).toBe(
      '3 tests passed [redacted credential]'
    );
    expect(JSON.stringify(events)).not.toContain('private input');
  });
});
