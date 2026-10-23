import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import type { SendResult } from '@kilocode/web-shared/lib/email';
import type { AutoRoutingPoolNoticeRouter } from '@kilocode/web-shared/lib/auto-routing-pool-notice-email';

export class PoolNotificationError extends Error {}

export type PoolNotificationOwner = {
  routers: AutoRoutingPoolNoticeRouter[];
  emails: string[];
};

export type PoolNotificationTarget = {
  to: string;
  routers: AutoRoutingPoolNoticeRouter[];
};

export type PoolNotificationPlan = {
  targets: PoolNotificationTarget[];
  unreachable: AutoRoutingPoolNoticeRouter[][];
};

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const targetStateSchema = z
  .object({
    routersHash: hashSchema,
    plannedRoutersHash: hashSchema.optional(),
    active: z.boolean().default(true),
    status: z.enum(['pending', 'attempted', 'sent', 'not_sent']),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    cutoverAt: z.iso.datetime(),
    hashKey: hashSchema,
    targets: z.record(hashSchema, targetStateSchema),
    unreachableOwners: z.array(hashSchema).optional(),
  })
  .strict();
type NotificationState = z.infer<typeof stateSchema>;

type PoolNotificationSummary = {
  ambiguous: number;
  remaining: number;
  failed: number;
  followupRequired: number;
  targetStatuses: {
    targetHash: string;
    status: z.infer<typeof targetStateSchema>['status'];
    active: boolean;
    requiresFollowup: boolean;
  }[];
};
export type PoolNotificationResult = PoolNotificationSummary &
  (
    | {
        mode: 'reconcile';
      }
    | {
        mode: 'send' | 'dry-run';
        recipients: number;
        unreachable: number;
        routers: number;
        sent: number;
        skipped: number;
        notSent: number;
      }
  );

const reconciliationSchema = z
  .object({
    targetHash: hashSchema,
    outcome: z.enum(['sent', 'not_sent']),
  })
  .strict();
type PoolNotificationReconciliation = z.infer<typeof reconciliationSchema>;
type PoolNotificationOptions = {
  cutoverAt: string;
  stateDir: string;
} & (
  | {
      send: boolean;
      refreshPlan?: boolean;
      reconcile?: undefined;
      owners: PoolNotificationOwner[];
      sendEmail: (target: PoolNotificationTarget, cutoverAt: string) => Promise<SendResult>;
    }
  | {
      send: false;
      refreshPlan?: false;
      reconcile: PoolNotificationReconciliation;
    }
);

export function parsePoolNotificationOptions(args: string[], now = Date.now()) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'cutover-at': { type: 'string' },
        'state-dir': { type: 'string' },
        send: { type: 'boolean', default: false },
        'refresh-plan': { type: 'boolean', default: false },
        'reconcile-target': { type: 'string' },
        'reconcile-outcome': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new PoolNotificationError(
      'Use --cutover-at, --state-dir and optionally --send, --refresh-plan, or --reconcile-target with --reconcile-outcome. See --help.'
    );
  }
  if (!values['state-dir']?.trim()) {
    throw new PoolNotificationError('--state-dir is required for the private resumable plan.');
  }
  const send = values.send ?? false;
  const refreshPlan = values['refresh-plan'] ?? false;
  const hasReconciliation =
    values['reconcile-target'] !== undefined || values['reconcile-outcome'] !== undefined;
  if ((send && refreshPlan) || (hasReconciliation && (send || refreshPlan))) {
    throw new PoolNotificationError(
      '--refresh-plan and reconciliation are dry-run operations and cannot be combined with --send or each other.'
    );
  }
  if (hasReconciliation) {
    const result = reconciliationSchema.safeParse({
      targetHash: values['reconcile-target'],
      outcome: values['reconcile-outcome'],
    });
    if (!result.success) {
      throw new PoolNotificationError(
        'Reconciliation requires --reconcile-target <64-character target hash> and --reconcile-outcome <sent|not_sent>, after checking provider records.'
      );
    }
    return {
      cutoverAt: parseCutoverAt(values['cutover-at']),
      stateDir: resolve(values['state-dir']),
      send: false as const,
      refreshPlan: false as const,
      reconcile: result.data,
    };
  }
  return {
    cutoverAt: validateCutoverAt(values['cutover-at'], now),
    stateDir: resolve(values['state-dir']),
    send,
    refreshPlan,
    reconcile: undefined,
  };
}

function parseCutoverAt(value: string | undefined): string {
  const result = z.iso.datetime({ offset: true }).safeParse(value);
  if (!result.success) {
    throw new PoolNotificationError(
      '--cutover-at must be an ISO timestamp with Z or a UTC offset.'
    );
  }
  return new Date(result.data).toISOString();
}

export function validateCutoverAt(value: string | undefined, now = Date.now()): string {
  let cutoverAt: string;
  try {
    cutoverAt = parseCutoverAt(value);
  } catch {
    throw new PoolNotificationError(
      '--cutover-at must be a future ISO timestamp with Z or a UTC offset.'
    );
  }
  if (Date.parse(cutoverAt) <= now) {
    throw new PoolNotificationError(
      '--cutover-at must be a future ISO timestamp with Z or a UTC offset.'
    );
  }
  return cutoverAt;
}

export function buildPoolNotificationTargets(
  owners: PoolNotificationOwner[]
): PoolNotificationPlan {
  const targets = new Map<string, PoolNotificationTarget>();
  const unreachable: AutoRoutingPoolNoticeRouter[][] = [];
  for (const owner of owners) {
    const emails = owner.emails
      .map(email => email.trim().toLowerCase())
      .filter(email => z.email().safeParse(email).success);
    if (emails.length === 0) {
      unreachable.push([...owner.routers].sort((a, b) => a.id.localeCompare(b.id)));
      continue;
    }
    for (const to of emails) {
      let target = targets.get(to);
      if (!target) {
        target = { to, routers: [] };
        targets.set(to, target);
      }
      for (const router of owner.routers) {
        if (!target.routers.some(existing => existing.id === router.id))
          target.routers.push(router);
      }
    }
  }
  return {
    targets: [...targets.values()]
      .map(target => ({
        ...target,
        routers: target.routers.sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.to.localeCompare(b.to)),
    unreachable,
  };
}

function unreachableOwnerHashes(hashKey: string, unreachable: AutoRoutingPoolNoticeRouter[][]) {
  return [
    ...new Set(
      unreachable.map(routers => hash(hashKey, JSON.stringify(routers.map(router => router.id))))
    ),
  ].sort();
}

function hash(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

async function openPrivateFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new PoolNotificationError('Notification state must be an owner-only regular file.');
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function readState(path: string): Promise<NotificationState | null> {
  let file;
  try {
    file = await openPrivateFile(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  try {
    const result = stateSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    if (!result.success)
      throw new PoolNotificationError(
        'Notification state is invalid; do not reset a previously used plan.'
      );
    return result.data;
  } catch (error) {
    if (error instanceof PoolNotificationError) throw error;
    throw new PoolNotificationError(
      'Notification state is unreadable; do not reset a previously used plan.'
    );
  } finally {
    await file.close();
  }
}

async function persistState(stateDir: string, state: NotificationState) {
  const temporaryPath = join(stateDir, `.state-${randomUUID()}.tmp`);
  const temporary = await open(temporaryPath, 'wx', 0o600);
  try {
    await temporary.writeFile(JSON.stringify(state) + '\n');
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  await rename(temporaryPath, join(stateDir, 'state.json'));
  const directory = await open(stateDir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function summarizeState(state: NotificationState): PoolNotificationSummary {
  const targetStatuses = Object.entries(state.targets)
    .map(([targetHash, target]) => ({
      targetHash,
      status: target.status,
      active: target.active,
      requiresFollowup:
        target.active &&
        target.status === 'sent' &&
        target.routersHash !== (target.plannedRoutersHash ?? target.routersHash),
    }))
    .sort((a, b) => a.targetHash.localeCompare(b.targetHash));
  return {
    ambiguous: targetStatuses.filter(target => target.status === 'attempted').length,
    remaining: targetStatuses.filter(target => target.active && target.status !== 'sent').length,
    failed: targetStatuses.filter(target => target.active && target.status === 'not_sent').length,
    followupRequired: targetStatuses.filter(target => target.requiresFollowup).length,
    targetStatuses,
  };
}

export async function runPoolNotifications(
  options: PoolNotificationOptions
): Promise<PoolNotificationResult> {
  if (
    (options.send && options.refreshPlan) ||
    (options.reconcile && (options.send || options.refreshPlan))
  ) {
    throw new PoolNotificationError(
      '--refresh-plan and reconciliation are dry-run operations and cannot be combined with --send or each other.'
    );
  }
  const cutoverAt = options.reconcile
    ? parseCutoverAt(options.cutoverAt)
    : validateCutoverAt(options.cutoverAt);
  const plan = options.reconcile ? null : buildPoolNotificationTargets(options.owners);
  const targets = plan?.targets ?? [];
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(options.stateDir);
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid?.()
  ) {
    throw new PoolNotificationError('--state-dir must be an owner-only directory, not a symlink.');
  }
  const lockPath = join(options.stateDir, 'notification.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      throw new PoolNotificationError(
        'Notification plan is locked. Confirm no sender is running before manually removing a stale lock.'
      );
    }
    throw error;
  }
  try {
    await lock.writeFile(String(process.pid) + '\n');
    await lock.sync();
    let state = await readState(join(options.stateDir, 'state.json'));
    if (!state) {
      if (options.send)
        throw new PoolNotificationError(
          'Run a dry run with this state directory before using --send.'
        );
      if (options.refreshPlan || options.reconcile) {
        throw new PoolNotificationError(
          'Recovery requires an existing saved plan; retain the original state directory.'
        );
      }
      state = {
        version: 1,
        cutoverAt,
        hashKey: randomBytes(32).toString('hex'),
        targets: {},
        unreachableOwners: [],
      };
      state.unreachableOwners = unreachableOwnerHashes(state.hashKey, plan?.unreachable ?? []);
      for (const target of targets) {
        state.targets[hash(state.hashKey, target.to)] = {
          routersHash: hash(state.hashKey, JSON.stringify(target.routers)),
          active: true,
          status: 'pending',
        };
      }
      await persistState(options.stateDir, state);
    }
    if (state.cutoverAt !== cutoverAt) {
      throw new PoolNotificationError(
        'Cutover timestamp differs from the saved plan. Keep its history and timestamp unchanged; a changed date requires a separately reviewed notification campaign in a new private directory, not a retry.'
      );
    }
    if (options.reconcile) {
      const reconciliation = reconciliationSchema.safeParse(options.reconcile);
      if (!reconciliation.success) {
        throw new PoolNotificationError(
          'Reconciliation requires a target hash and a provider-confirmed sent or not_sent outcome.'
        );
      }
      const entry = state.targets[reconciliation.data.targetHash];
      if (!entry || entry.status !== 'attempted') {
        throw new PoolNotificationError(
          'Only an attempted target with an unknown provider outcome can be reconciled.'
        );
      }
      entry.status = reconciliation.data.outcome;
      await persistState(options.stateDir, state);
      return { mode: 'reconcile', ...summarizeState(state) };
    }
    const livePlan = new Map(
      targets.map(target => [
        hash(state.hashKey, target.to),
        hash(state.hashKey, JSON.stringify(target.routers)),
      ])
    );
    const liveUnreachable = unreachableOwnerHashes(state.hashKey, plan?.unreachable ?? []);
    if (options.refreshPlan) {
      for (const [targetHash, entry] of Object.entries(state.targets)) {
        entry.active = livePlan.has(targetHash);
      }
      state.unreachableOwners = liveUnreachable;
      for (const [targetHash, routersHash] of livePlan) {
        const entry = state.targets[targetHash];
        if (entry) {
          entry.active = true;
          entry.plannedRoutersHash = routersHash;
        } else {
          state.targets[targetHash] = { routersHash, status: 'pending', active: true };
        }
      }
      await persistState(options.stateDir, state);
    } else if (
      targets.length !== Object.values(state.targets).filter(target => target.active).length ||
      JSON.stringify(liveUnreachable) !== JSON.stringify(state.unreachableOwners ?? []) ||
      [...livePlan].some(([targetHash, routersHash]) => {
        const entry = state.targets[targetHash];
        return !entry?.active || (entry.plannedRoutersHash ?? entry.routersHash) !== routersHash;
      })
    ) {
      throw new PoolNotificationError(
        'Live recipients or routers differ from the saved plan; review --refresh-plan without discarding delivery history.'
      );
    }
    let sent = 0;
    let skipped = 0;
    let notSent = 0;
    for (const target of targets) {
      const entry = state.targets[hash(state.hashKey, target.to)];
      if (!entry)
        throw new PoolNotificationError('Notification target is absent from the saved plan.');
      if (entry.status === 'sent') {
        skipped++;
        continue;
      }
      if (entry.status === 'attempted') continue;
      if (!options.send) continue;
      validateCutoverAt(cutoverAt);
      entry.routersHash = hash(state.hashKey, JSON.stringify(target.routers));
      entry.status = 'attempted';
      await persistState(options.stateDir, state);
      let result: SendResult;
      try {
        result = await options.sendEmail(target, cutoverAt);
      } catch {
        continue;
      }
      entry.status = result.sent ? 'sent' : 'not_sent';
      await persistState(options.stateDir, state);
      if (result.sent) sent++;
      else notSent++;
    }
    return {
      mode: options.send ? 'send' : 'dry-run',
      recipients: targets.length,
      unreachable: liveUnreachable.length,
      routers: new Set(targets.flatMap(target => target.routers.map(router => router.id))).size,
      sent,
      skipped,
      notSent,
      ...summarizeState(state),
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
