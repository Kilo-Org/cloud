import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPoolNotificationTargets,
  parsePoolNotificationOptions,
  runPoolNotifications,
  validateCutoverAt,
} from '../scripts/lib/auto-routing-pool-notifications';
import type {
  PoolNotificationOwner,
  PoolNotificationTarget,
} from '../scripts/lib/auto-routing-pool-notifications';
import type { SendResult } from '@kilocode/web-shared/lib/email';

const cutoverAt = '2099-11-01T12:00:00.000Z';
const personalRouter = {
  id: 'personal-router',
  modelId: 'kilo-auto/custom/efficient',
  organization: null,
};
const organizationRouter = {
  id: 'organization-router',
  modelId: 'kilo-auto/custom/org/efficient',
  organization: { id: 'organization-id', name: 'Fixture Organization' },
};
const owners: PoolNotificationOwner[] = [
  { routers: [personalRouter], emails: ['owner@example.test'] },
  { routers: [organizationRouter], emails: [' OWNER@example.test ', 'billing@example.test'] },
];

type StoredPlan = {
  cutoverAt: string;
  hashKey: string;
  targets: Record<
    string,
    {
      routersHash: string;
      plannedRoutersHash?: string;
      status: string;
      active?: boolean;
    }
  >;
};

async function readPlan(): Promise<StoredPlan> {
  return JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as StoredPlan;
}

function targetHash(plan: StoredPlan, email: string) {
  return createHmac('sha256', plan.hashKey).update(email.trim().toLowerCase()).digest('hex');
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'pool-notifications-'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(stateDir, { recursive: true, force: true });
});

describe('pool notice planning', () => {
  it('defaults to dry run and canonicalizes an explicitly zoned future cutover', () => {
    const options = parsePoolNotificationOptions([
      '--cutover-at',
      '2099-11-01T14:00:00+02:00',
      '--state-dir',
      stateDir,
    ]);
    expect(options).toEqual({
      cutoverAt,
      stateDir,
      send: false,
      refreshPlan: false,
      reconcile: undefined,
    });
    expect(
      parsePoolNotificationOptions(['--cutover-at', cutoverAt, '--state-dir', stateDir, '--send'])
        .send
    ).toBe(true);
  });

  it.each([
    undefined,
    '2099-11-01',
    '2099-11-01T12:00:00',
    '2000-01-01T00:00:00Z',
    '2099-02-30T00:00:00Z',
  ])('rejects missing, unzoned, invalid, or past cutovers: %s', value => {
    expect(() => validateCutoverAt(value)).toThrow(/future ISO timestamp/);
  });

  it('rejects missing state and unknown flags', () => {
    expect(() => parsePoolNotificationOptions(['--cutover-at', cutoverAt])).toThrow(/state-dir/);
    expect(() => parsePoolNotificationOptions(['--email=private@example.test'])).toThrow(
      /Use --cutover-at/
    );
  });

  it('requires complete provider reconciliation flags and separates recovery from sending', () => {
    const base = ['--cutover-at', cutoverAt, '--state-dir', stateDir];
    const hash = 'a'.repeat(64);
    for (const flags of [
      ['--reconcile-target', hash],
      ['--reconcile-outcome', 'sent'],
      ['--reconcile-target', 'private@example.test', '--reconcile-outcome', 'sent'],
      ['--reconcile-target', hash, '--reconcile-outcome', 'unknown'],
      ['--refresh-plan', '--send'],
      ['--reconcile-target', hash, '--reconcile-outcome', 'sent', '--send'],
      ['--reconcile-target', hash, '--reconcile-outcome', 'sent', '--refresh-plan'],
    ]) {
      expect(() => parsePoolNotificationOptions([...base, ...flags])).toThrow();
    }
    expect(
      parsePoolNotificationOptions([
        '--cutover-at',
        '2000-01-01T00:00:00Z',
        '--state-dir',
        stateDir,
        '--reconcile-target',
        hash,
        '--reconcile-outcome',
        'not_sent',
      ])
    ).toMatchObject({
      send: false,
      reconcile: { targetHash: hash, outcome: 'not_sent' },
    });
  });

  it('deduplicates a recipient across personal and multiple organization contacts with all router IDs', () => {
    const targets = buildPoolNotificationTargets([
      ...owners,
      { routers: [organizationRouter], emails: ['owner@example.test'] },
    ]);
    expect(targets).toHaveLength(2);
    expect(targets.find(target => target.to === 'owner@example.test')?.routers).toEqual([
      organizationRouter,
      personalRouter,
    ]);
    expect(targets.find(target => target.to === 'billing@example.test')?.routers).toEqual([
      organizationRouter,
    ]);
  });

  it('blocks every email if any affected organization has no live billing contact', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>();
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir,
        send: true,
        owners: [...owners, { routers: [organizationRouter], emails: [] }],
        sendEmail,
      })
    ).rejects.toThrow(/no live billing contact/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not echo an invalid recipient in its error', () => {
    expect(() =>
      buildPoolNotificationTargets([
        { routers: [personalRouter], emails: ['private-invalid-contact'] },
      ])
    ).toThrow('An affected contact has an invalid email; reconcile before sending.');
  });
});

describe('private resumable pool notices', () => {
  it('persists only hashed targets with private file permissions and never calls mail in a dry run', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>();
    const result = await runPoolNotifications({
      cutoverAt,
      stateDir,
      send: false,
      owners,
      sendEmail,
    });
    expect(result).toMatchObject({
      mode: 'dry-run',
      recipients: 2,
      routers: 2,
      sent: 0,
      skipped: 0,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    const state = await readFile(join(stateDir, 'state.json'), 'utf8');
    for (const sensitive of [
      'owner@example.test',
      'billing@example.test',
      'personal-router',
      'organization-id',
      'Fixture Organization',
      'kilo-auto',
    ]) {
      expect(state).not.toContain(sensitive);
    }
    expect(JSON.stringify(result)).not.toMatch(
      /owner@example|billing@example|Fixture Organization|kilo-auto/
    );
    expect(result.targetStatuses).toEqual([
      expect.objectContaining({
        targetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'pending',
        active: true,
      }),
      expect.objectContaining({
        targetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'pending',
        active: true,
      }),
    ]);
    expect((await lstat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(stateDir, 'state.json'))).mode & 0o777).toBe(0o600);
    await expect(lstat(join(stateDir, 'notification.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('requires a saved dry-run plan before explicit sending', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>();
    await expect(
      runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
    ).rejects.toThrow(/dry run/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('requires the original saved plan for refresh and reconciliation', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>();
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        refreshPlan: true,
        owners,
        sendEmail,
      })
    ).rejects.toThrow(/existing saved plan/);
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        reconcile: { targetHash: 'a'.repeat(64), outcome: 'sent' },
      })
    ).rejects.toThrow(/existing saved plan/);
    expect(sendEmail).not.toHaveBeenCalled();
    await expect(lstat(join(stateDir, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('durably records an attempt before handing any recipient to mail and skips sent targets on resume', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>().mockImplementation(async () => {
      const state = await readFile(join(stateDir, 'state.json'), 'utf8');
      expect(state).toContain('"status":"attempted"');
      return { sent: true };
    });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    expect(
      await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
    ).toMatchObject({ sent: 2, skipped: 0 });
    expect(
      await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
    ).toMatchObject({ sent: 0, skipped: 2 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('continues independent deliveries after an unknown outcome and never retries it implicitly', async () => {
    const sendEmail = jest
      .fn<() => Promise<SendResult>>()
      .mockRejectedValueOnce(new Error('private billing@example.test'))
      .mockResolvedValue({ sent: true });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    const result = await runPoolNotifications({
      cutoverAt,
      stateDir,
      send: true,
      owners,
      sendEmail,
    });
    expect(result).toMatchObject({ sent: 1, ambiguous: 1, remaining: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const plan = await readPlan();
    expect(result.targetStatuses).toContainEqual({
      targetHash: targetHash(plan, 'billing@example.test'),
      status: 'attempted',
      active: true,
      requiresFollowup: false,
    });
    expect(JSON.stringify(result)).not.toContain('billing@example.test');
    const resumedSender = jest.fn<() => Promise<SendResult>>();
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: true,
        owners,
        sendEmail: resumedSender,
      })
    ).toMatchObject({ sent: 0, skipped: 1, ambiguous: 1 });
    expect(resumedSender).not.toHaveBeenCalled();
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        owners,
        sendEmail: resumedSender,
      })
    ).toMatchObject({ ambiguous: 1 });
  });

  it.each(['sent', 'not_sent'] as const)(
    'resumes only according to an explicitly reconciled %s outcome',
    async outcome => {
      const sendEmail = jest
        .fn<() => Promise<SendResult>>()
        .mockRejectedValueOnce(new Error('provider connection reset'))
        .mockResolvedValue({ sent: true });
      await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
      await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail });
      const plan = await readPlan();
      const attemptedHash = targetHash(plan, 'billing@example.test');
      expect(
        await runPoolNotifications({
          cutoverAt,
          stateDir,
          send: false,
          reconcile: { targetHash: attemptedHash, outcome },
        })
      ).toMatchObject({ mode: 'reconcile', ambiguous: 0 });
      const after = await readPlan();
      expect(after.hashKey).toBe(plan.hashKey);
      expect(after.cutoverAt).toBe(plan.cutoverAt);
      expect(after.targets[attemptedHash]).toEqual({
        ...plan.targets[attemptedHash],
        status: outcome,
      });
      expect(after.targets[targetHash(plan, 'owner@example.test')]).toEqual(
        plan.targets[targetHash(plan, 'owner@example.test')]
      );
      sendEmail.mockClear();
      expect(
        await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
      ).toMatchObject({
        sent: outcome === 'sent' ? 0 : 1,
        skipped: outcome === 'sent' ? 2 : 1,
        ambiguous: 0,
      });
      expect(sendEmail).toHaveBeenCalledTimes(outcome === 'sent' ? 0 : 1);
    }
  );

  it('rejects reconciliation of pending, sent or absent targets without changing history', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>().mockResolvedValue({ sent: true });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    const pending = await readPlan();
    for (const hash of [targetHash(pending, 'billing@example.test'), 'a'.repeat(64)]) {
      await expect(
        runPoolNotifications({
          cutoverAt,
          stateDir,
          send: false,
          reconcile: { targetHash: hash, outcome: 'sent' },
        })
      ).rejects.toThrow(/Only an attempted target/);
      expect(await readPlan()).toEqual(pending);
    }
    await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail });
    const sent = await readPlan();
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        reconcile: { targetHash: targetHash(sent, 'billing@example.test'), outcome: 'not_sent' },
      })
    ).rejects.toThrow(/Only an attempted target/);
    expect(await readPlan()).toEqual(sent);
  });

  it('allows provider reconciliation after the saved cutover passes but never changes its date', async () => {
    const sendEmail = jest
      .fn<() => Promise<SendResult>>()
      .mockRejectedValue(new Error('unknown outcome'));
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail });
    const plan = await readPlan();
    const hash = targetHash(plan, 'billing@example.test');
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'));
    await expect(
      runPoolNotifications({
        cutoverAt: '2099-11-02T12:00:00Z',
        stateDir,
        send: false,
        reconcile: { targetHash: hash, outcome: 'sent' },
      })
    ).rejects.toThrow(/timestamp differs/);
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        reconcile: { targetHash: hash, outcome: 'sent' },
      })
    ).toMatchObject({ mode: 'reconcile', ambiguous: 1 });
    expect((await readPlan()).cutoverAt).toBe(cutoverAt);
  });

  it('permits explicit retries of a known not-sent result without resending successful targets', async () => {
    const sendEmail = jest
      .fn<() => Promise<SendResult>>()
      .mockResolvedValueOnce({ sent: false, reason: 'neverbounce_rejected' })
      .mockResolvedValue({ sent: true });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    expect(
      await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
    ).toMatchObject({ sent: 1, notSent: 1 });
    expect(
      await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
    ).toMatchObject({ sent: 1, skipped: 1, notSent: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it('rejects changed recipients, changed router lists, and changed cutover dates before sending', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>();
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir,
        send: true,
        owners: [{ routers: [personalRouter], emails: ['new-contact@example.test'] }],
        sendEmail,
      })
    ).rejects.toThrow(/differ from the saved plan/);
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir,
        send: true,
        owners: [
          ...owners,
          {
            routers: [{ ...personalRouter, id: 'another-router' }],
            emails: ['owner@example.test'],
          },
        ],
        sendEmail,
      })
    ).rejects.toThrow(/differ from the saved plan/);
    await expect(
      runPoolNotifications({
        cutoverAt: '2099-11-02T12:00:00Z',
        stateDir,
        send: true,
        owners,
        sendEmail,
      })
    ).rejects.toThrow(/timestamp differs/);
    const plan = await readPlan();
    await expect(
      runPoolNotifications({
        cutoverAt: '2099-11-02T12:00:00Z',
        stateDir,
        send: false,
        refreshPlan: true,
        owners,
        sendEmail,
      })
    ).rejects.toThrow(/timestamp differs/);
    expect(await readPlan()).toEqual(plan);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refreshes the live plan only on explicit dry run, preserving removed pending history and adding new recipients', async () => {
    const sendEmail = jest
      .fn<(target: PoolNotificationTarget) => Promise<SendResult>>()
      .mockResolvedValue({ sent: true });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    const before = await readPlan();
    const refreshedOwners = [
      { routers: [personalRouter], emails: ['owner@example.test'] },
      { routers: [organizationRouter], emails: ['new-contact@example.test'] },
    ];
    await expect(
      runPoolNotifications({ cutoverAt, stateDir, send: true, owners: refreshedOwners, sendEmail })
    ).rejects.toThrow(/differ from the saved plan/);
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        refreshPlan: true,
        owners: refreshedOwners,
        sendEmail,
      })
    ).toMatchObject({ mode: 'dry-run', recipients: 2, sent: 0, remaining: 2, followupRequired: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    const refreshed = await readPlan();
    expect(refreshed.cutoverAt).toBe(before.cutoverAt);
    expect(refreshed.hashKey).toBe(before.hashKey);
    expect(refreshed.targets[targetHash(before, 'billing@example.test')]).toEqual({
      ...before.targets[targetHash(before, 'billing@example.test')],
      active: false,
    });
    expect(refreshed.targets[targetHash(before, 'new-contact@example.test')]).toMatchObject({
      status: 'pending',
      active: true,
    });
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: true,
        owners: refreshedOwners,
        sendEmail,
      })
    ).toMatchObject({ sent: 2, remaining: 0 });
    expect(sendEmail.mock.calls.map(([target]) => target.to)).toEqual([
      'new-contact@example.test',
      'owner@example.test',
    ]);
    expect(
      sendEmail.mock.calls.find(([target]) => target.to === 'owner@example.test')?.[0].routers
    ).toEqual([personalRouter]);
  });

  it('never resends sent recipients after metadata changes, removal, or reintroduction in the same campaign', async () => {
    const sendEmail = jest
      .fn<(target: PoolNotificationTarget) => Promise<SendResult>>()
      .mockResolvedValue({ sent: true });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail });
    const before = await readPlan();
    sendEmail.mockClear();
    const refreshedOwners = [
      { routers: [personalRouter], emails: ['owner@example.test'] },
      { routers: [organizationRouter], emails: ['new-contact@example.test'] },
    ];
    const refreshed = await runPoolNotifications({
      cutoverAt,
      stateDir,
      send: false,
      refreshPlan: true,
      owners: refreshedOwners,
      sendEmail,
    });
    expect(refreshed).toMatchObject({ followupRequired: 1, remaining: 1 });
    expect(refreshed.targetStatuses).toContainEqual({
      targetHash: targetHash(before, 'owner@example.test'),
      status: 'sent',
      active: true,
      requiresFollowup: true,
    });
    const after = await readPlan();
    expect(after.targets[targetHash(before, 'owner@example.test')].routersHash).toBe(
      before.targets[targetHash(before, 'owner@example.test')].routersHash
    );
    expect(after.targets[targetHash(before, 'billing@example.test')]).toEqual({
      ...before.targets[targetHash(before, 'billing@example.test')],
      active: false,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: true,
        owners: refreshedOwners,
        sendEmail,
      })
    ).toMatchObject({ sent: 1, skipped: 1, followupRequired: 1 });
    expect(sendEmail.mock.calls.map(([target]) => target.to)).toEqual(['new-contact@example.test']);
    sendEmail.mockClear();
    const restoredOwners = [
      ...owners,
      { routers: [organizationRouter], emails: ['new-contact@example.test'] },
    ];
    await runPoolNotifications({
      cutoverAt,
      stateDir,
      send: false,
      refreshPlan: true,
      owners: restoredOwners,
      sendEmail,
    });
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: true,
        owners: restoredOwners,
        sendEmail,
      })
    ).toMatchObject({ sent: 0, skipped: 3, followupRequired: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('retains removed unknown outcomes while sending new pending recipients and preserves attempted metadata on reconciliation', async () => {
    const sendEmail = jest
      .fn<(target: PoolNotificationTarget) => Promise<SendResult>>()
      .mockRejectedValueOnce(new Error('ambiguous transport'))
      .mockResolvedValue({ sent: true });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail });
    const before = await readPlan();
    const attemptedHash = targetHash(before, 'billing@example.test');
    const onlyNew = [{ routers: [organizationRouter], emails: ['new-contact@example.test'] }];
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        refreshPlan: true,
        owners: onlyNew,
        sendEmail,
      })
    ).toMatchObject({ ambiguous: 1, remaining: 1 });
    sendEmail.mockClear();
    const result = await runPoolNotifications({
      cutoverAt,
      stateDir,
      send: true,
      owners: onlyNew,
      sendEmail,
    });
    expect(result).toMatchObject({ sent: 1, ambiguous: 1, remaining: 0 });
    expect(result.targetStatuses).toContainEqual({
      targetHash: attemptedHash,
      status: 'attempted',
      active: false,
      requiresFollowup: false,
    });
    expect(sendEmail.mock.calls.map(([target]) => target.to)).toEqual(['new-contact@example.test']);
    const renamedRouter = {
      ...organizationRouter,
      organization: { ...organizationRouter.organization, name: 'Updated Fixture' },
    };
    const reintroduced = [
      ...onlyNew,
      { routers: [renamedRouter], emails: ['billing@example.test'] },
    ];
    await runPoolNotifications({
      cutoverAt,
      stateDir,
      send: false,
      refreshPlan: true,
      owners: reintroduced,
      sendEmail,
    });
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        reconcile: { targetHash: attemptedHash, outcome: 'sent' },
      })
    ).toMatchObject({ ambiguous: 0, followupRequired: 1 });
    expect((await readPlan()).targets[attemptedHash].routersHash).toBe(
      before.targets[attemptedHash].routersHash
    );
    sendEmail.mockClear();
    expect(
      await runPoolNotifications({
        cutoverAt,
        stateDir,
        send: true,
        owners: reintroduced,
        sendEmail,
      })
    ).toMatchObject({ sent: 0, skipped: 2, followupRequired: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('fails refresh before changing the plan if any affected owner loses its billing contacts', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>().mockResolvedValue({ sent: true });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    const before = await readPlan();
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        refreshPlan: true,
        owners: [...owners, { routers: [organizationRouter], emails: [] }],
        sendEmail,
      })
    ).rejects.toThrow(/no live billing contact/);
    expect(await readPlan()).toEqual(before);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('preserves sent history from an existing plan without refresh metadata fields', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>().mockResolvedValue({ sent: true });
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail });
    const plan = await readPlan();
    for (const target of Object.values(plan.targets)) delete target.active;
    await writeFile(join(stateDir, 'state.json'), JSON.stringify(plan));
    sendEmail.mockClear();
    expect(
      await runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
    ).toMatchObject({ sent: 0, skipped: 2 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('holds an exclusive lock while mail is in flight', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>();
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const sending = new Promise<void>(resolve => {
      entered = resolve;
    });
    const first = runPoolNotifications({
      cutoverAt,
      stateDir,
      send: true,
      owners,
      sendEmail: async () => {
        entered();
        await blocked;
        return { sent: true };
      },
    });
    await sending;
    try {
      await expect(
        runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
      ).rejects.toThrow(/locked/);
      expect(sendEmail).not.toHaveBeenCalled();
    } finally {
      release();
      await first;
    }
  });

  it('does not automatically steal a stale-looking lock', async () => {
    await writeFile(join(stateDir, 'notification.lock'), '99999999\n', { mode: 0o600 });
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir,
        send: false,
        owners,
        sendEmail: jest.fn<() => Promise<SendResult>>(),
      })
    ).rejects.toThrow(/locked/);
    expect(await readFile(join(stateDir, 'notification.lock'), 'utf8')).toBe('99999999\n');
  });

  it('rejects shared directories, non-private state, symlinks, and invalid state', async () => {
    const sendEmail = jest.fn<() => Promise<SendResult>>();
    await chmod(stateDir, 0o755);
    await expect(
      runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail })
    ).rejects.toThrow(/owner-only directory/);
    await chmod(stateDir, 0o700);
    await runPoolNotifications({ cutoverAt, stateDir, send: false, owners, sendEmail });
    await chmod(join(stateDir, 'state.json'), 0o644);
    await expect(
      runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
    ).rejects.toThrow(/owner-only regular file/);
    await chmod(join(stateDir, 'state.json'), 0o600);
    await symlink(stateDir, join(stateDir, 'alias'));
    await expect(
      runPoolNotifications({
        cutoverAt,
        stateDir: join(stateDir, 'alias'),
        send: true,
        owners,
        sendEmail,
      })
    ).rejects.toThrow(/owner-only directory/);
    await writeFile(join(stateDir, 'state.json'), '{ broken state');
    await expect(
      runPoolNotifications({ cutoverAt, stateDir, send: true, owners, sendEmail })
    ).rejects.toThrow(/state is unreadable/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
