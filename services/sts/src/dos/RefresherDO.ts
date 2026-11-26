import { withDORetry } from '@kilocode/worker-utils';
import { WorkloadNameSchema } from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from '../../drizzle.refresher/migrations';
import { managerReferenceRefusedEvent, policyChangedEvent } from '../audit/events';
import { AuditLog } from '../audit/log';
import {
  acceptFolderRead,
  FolderCopySchema,
  resolveWorkloadSecrets,
  type FolderCopy,
  type RefusedReference,
} from '../bundle/resolve';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  POLICY_CHANGE_REFRESH_DELAY_MS,
  REFRESH_INTERVAL_MS,
  RELAY_DELAY_MS,
  RELAY_RETRY_MS,
  SNAPSHOT_FILL_MAX_AGE_MS,
  WEBHOOK_MERGE_WINDOW_MS,
} from '../constants';
import { createEncryptionKey, openJson, sealJson } from '../crypto/aes';
import { loadOrCreateKey } from '../crypto/key-store';
import * as schema from '../db/refresher-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import { InfisicalClient, type ManagerFolder } from '../infisical/client';
import { policyIndex } from '../policy';
import type { PolicyIndex, PolicySnapshotEntry } from '../policy/load';
import { PolicySnapshotSchema, bundleFolder, type Policy } from '../policy/schema';
import type { FillResult, WorkloadBundle } from '../types';
import { getBundleStub, getSignerStub } from './stubs';

type RefresherDatabase = DrizzleSqliteDODatabase<typeof schema>;

/** KV storage key of the folder seal key (see `crypto/key-store.ts`). */
const SEAL_KEY_NAME = 'refresher-seal-key';
type RefresherState = typeof schema.refresherState.$inferSelect;

/** The folder copies from one successful read; `ci` stays empty where no policy reads `/ci`. */
type ManagerView = { workloads: FolderCopy; shared: FolderCopy; ci: FolderCopy; fetchedAt: number };

const EMPTY_FOLDER: FolderCopy = { entries: [], refused: [] };

function managerView(copies: Map<ManagerFolder, FolderCopy>, fetchedAt: number): ManagerView {
  return {
    workloads: copies.get('/workloads') ?? EMPTY_FOLDER,
    shared: copies.get('/shared') ?? EMPTY_FOLDER,
    ci: copies.get('/ci') ?? EMPTY_FOLDER,
    fetchedAt,
  };
}

type FolderRead = Exclude<FolderOutcome, { status: 'unreachable' }>;

type ReadOutcome =
  | { status: 'ok'; view: ManagerView }
  | { status: 'unreachable'; detail: string; retryAfterMs: number | null };

type FolderOutcome =
  | { status: 'unchanged'; copy: FolderCopy }
  | {
      status: 'changed';
      copy: FolderCopy;
      etag: string | null;
      hidden: number;
      newlyRefused: Array<RefusedReference & { keptLastGood: boolean }>;
    }
  | { status: 'unreachable'; detail: string; retryAfterMs: number | null };

type StoredFolder = { etag: string | null; fetchedAt: number; copy: FolderCopy | null };

/**
 * Delay before retry number `failures` after consecutive failed manager reads: exponential from
 * 15 seconds, capped at the 4-minute cadence, with jitter over the upper half. A 429's
 * `Retry-After` raises it, up to the same cap (design 4.2).
 */
export function backoffDelayMs(failures: number, retryAfterMs: number | null): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  const jittered = ceiling / 2 + Math.random() * (ceiling / 2);
  return Math.min(BACKOFF_CAP_MS, Math.max(jittered, retryAfterMs ?? 0));
}

function dueAt(state: RefresherState): number {
  return Math.min(state.nextRefreshAt, state.webhookRefreshAt ?? Number.POSITIVE_INFINITY);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * One object per environment. It reads the manager's `/workloads` and `/shared` folders, and `/ci`
 * when a GitHub policy here needs it, together every 4 minutes, sooner after a signed
 * `secrets.modified` webhook (merged per 30-second window) or a policy change, and with backoff
 * after a failure. Each read rebuilds every workload's bundle from policy and pushes it to that
 * workload's object. Concurrent reads, including the logins they need, merge into one. It also owns
 * the policy-change and refused-reference audit events.
 */
export class RefresherDO extends DurableObject<Env> {
  /** The policies this object serves; a test fixture's subclass sets its own. */
  static readonly policies: PolicyIndex = policyIndex;

  private readonly config: StsConfig;
  private readonly db: RefresherDatabase;
  private readonly audit: AuditLog;
  private readonly stream: string;
  private readonly client: InfisicalClient;
  // An instance field, not a method: RPC exposes prototype methods, never instance fields.
  private readonly policies: PolicyIndex;
  private pendingRead: Promise<ReadOutcome> | null = null;
  private sealKey: Promise<string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    this.policies = new.target.policies;
    this.db = drizzle(ctx.storage, { schema });
    this.stream = `sts:${this.config.environment}:refresher`;
    this.audit = new AuditLog(ctx.storage, env.AUDIT_QUEUE);
    this.client = new InfisicalClient(this.config.manager, () =>
      withDORetry(
        () => getSignerStub(this.env, this.config),
        stub => stub.signManagerToken(),
        'sts.signManagerToken'
      )
    );
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  /**
   * Makes sure the alarm loop runs and records a policy change the last deploy introduced. Bundle
   * objects call it in the background at most once a minute; it never sits on a read.
   */
  async ensureStarted(): Promise<void> {
    this.webhookSecretValue();
    const now = Date.now();
    this.state(now);
    try {
      if (await this.applyPolicyChange()) {
        this.requestEarlyRefresh(now, POLICY_CHANGE_REFRESH_DELAY_MS);
      }
    } catch (error) {
      console.error('sts: policy-change audit append failed', { reason: errorName(error) });
    }
    await this.scheduleAlarm(now, false);
  }

  /**
   * The secret Infisical signs this environment's webhook with. The STS Worker verifies webhooks
   * itself with it, so only a verified `secrets.modified` reaches this object.
   */
  async webhookSecret(): Promise<string> {
    return this.webhookSecretValue();
  }

  /** Called by the Worker after it verified a `secrets.modified` webhook for this environment. */
  async requestWebhookRefresh(): Promise<void> {
    const now = Date.now();
    this.requestEarlyRefresh(now, WEBHOOK_MERGE_WINDOW_MS);
    await this.scheduleAlarm(now, false);
  }

  /**
   * Builds one bundle for an empty bundle object. A manager copy from the current cadence is used
   * as is; otherwise this reads the manager, unless a backoff is running. With no new read, the
   * last copy is served stale.
   */
  async buildBundle(workload: string): Promise<FillResult> {
    const policy = this.policies.get(this.config.environment, WorkloadNameSchema.parse(workload));
    if (policy === null) return { status: 'no_policy' };
    const now = Date.now();
    const stored = await this.storedView();
    const state = this.state(now);
    const current =
      stored !== null && state.failures === 0 && now - stored.fetchedAt <= SNAPSHOT_FILL_MAX_AGE_MS;
    if (current) return { status: 'built', bundle: await this.bundleFor(policy, stored, false) };

    if (state.failures === 0 || now >= state.nextRefreshAt) {
      const read = await this.readManager();
      if (read.status === 'ok') {
        return { status: 'built', bundle: await this.bundleFor(policy, read.view, false) };
      }
      await this.scheduleAlarm(Date.now(), false);
    }
    if (stored === null) return { status: 'unavailable' };
    return { status: 'built', bundle: await this.bundleFor(policy, stored, true) };
  }

  /** One refresh now, regardless of the schedule. The alarm calls it when due. */
  async refreshAll(): Promise<void> {
    const now = Date.now();
    this.state(now);
    this.db
      .update(schema.refresherState)
      .set({ webhookRefreshAt: null, lastRefreshAt: now })
      .where(eq(schema.refresherState.id, 1))
      .run();
    try {
      await this.applyPolicyChange();
    } catch (error) {
      // The policy is already deployed; refusing to refresh would not undo it, only stop
      // rotations reaching workloads. The event is retried on the next refresh.
      console.error('sts: policy-change audit append failed', { reason: errorName(error) });
    }
    const read = await this.readManager();
    if (read.status === 'ok') {
      await this.pushAll(read.view, false);
      return;
    }
    const stored = await this.storedView();
    if (stored !== null) await this.pushAll(stored, true);
  }

  async alarm(): Promise<void> {
    let relayFailed = false;
    try {
      await this.audit.relay(this.stream);
    } catch (error) {
      relayFailed = true;
      console.warn('sts: refresher audit relay failed; rows stay for the next alarm', {
        reason: errorName(error),
      });
    }
    const now = Date.now();
    this.audit.pruneIfDue(now);
    if (dueAt(this.state(now)) <= now) await this.refreshAll();
    await this.scheduleAlarm(Date.now(), relayFailed);
  }

  private readManager(): Promise<ReadOutcome> {
    if (this.pendingRead !== null) return this.pendingRead;
    const pending = this.performRead().finally(() => {
      this.pendingRead = null;
    });
    this.pendingRead = pending;
    return pending;
  }

  /** `/ci` holds the bundles of GitHub policies only, so it is read where one of them applies. */
  private managerFolders(): ManagerFolder[] {
    const readsCi = this.policies
      .forEnvironment(this.config.environment)
      .some(policy => bundleFolder(policy).root === '/ci');
    return readsCi ? ['/workloads', '/shared', '/ci'] : ['/workloads', '/shared'];
  }

  private async performRead(): Promise<ReadOutcome> {
    const startedAt = Date.now();
    const stored = await this.storedFolders();
    const outcomes = await Promise.all(
      this.managerFolders().map(
        async folder => [folder, await this.readFolder(folder, stored.get(folder) ?? null)] as const
      )
    );
    const reads: Array<readonly [ManagerFolder, FolderRead]> = [];
    for (const [folder, outcome] of outcomes) {
      if (outcome.status === 'unreachable') return this.failedRead(startedAt, outcome);
      reads.push([folder, outcome]);
    }

    const key = await this.snapshotKey();
    const copies = new Map<ManagerFolder, FolderCopy>();
    for (const [folder, outcome] of reads) {
      copies.set(folder, outcome.copy);
      if (outcome.status === 'unchanged') {
        this.db
          .update(schema.managerFolder)
          .set({ fetchedAt: startedAt })
          .where(eq(schema.managerFolder.folder, folder))
          .run();
        continue;
      }
      const sealed = await sealJson(key, outcome.copy);
      this.db
        .insert(schema.managerFolder)
        .values({ folder, etag: outcome.etag, fetchedAt: startedAt, ...sealed })
        .onConflictDoUpdate({
          target: schema.managerFolder.folder,
          set: { etag: outcome.etag, fetchedAt: startedAt, ...sealed },
        })
        .run();
      if (outcome.hidden > 0) {
        console.warn('sts: manager hid secret values from the STS identity', {
          environment: this.config.environment,
          folder,
          hidden: outcome.hidden,
        });
      }
      await this.reportRefused(outcome.newlyRefused);
    }
    this.recordSuccess(startedAt);
    return { status: 'ok', view: managerView(copies, startedAt) };
  }

  private failedRead(
    startedAt: number,
    outcome: Extract<FolderOutcome, { status: 'unreachable' }>
  ): ReadOutcome {
    this.recordFailure(startedAt, outcome.detail, outcome.retryAfterMs);
    return outcome;
  }

  private async readFolder(
    folder: ManagerFolder,
    stored: StoredFolder | null
  ): Promise<FolderOutcome> {
    const previous = stored?.copy ?? null;
    let read = await this.client.readFolder(
      folder,
      previous === null ? null : (stored?.etag ?? null)
    );
    if (read.status === 'not_modified') {
      if (previous !== null) return { status: 'unchanged', copy: previous };
      read = await this.client.readFolder(folder, null);
      if (read.status === 'not_modified') {
        return {
          status: 'unreachable',
          detail: 'manager answered 304 to an unconditional read',
          retryAfterMs: null,
        };
      }
    }
    if (read.status === 'unreachable') return read;
    const accepted = acceptFolderRead(read.entries, previous);
    return {
      status: 'changed',
      copy: accepted.copy,
      etag: read.etag,
      hidden: read.hidden,
      newlyRefused: accepted.newlyRefused,
    };
  }

  /** A refused reference is a configuration error in the manager: log it and audit it, once. */
  private async reportRefused(
    refused: Array<RefusedReference & { keptLastGood: boolean }>
  ): Promise<void> {
    for (const reference of refused) {
      console.error('sts: manager value refused: secret reference syntax', {
        environment: this.config.environment,
        path: reference.path,
        name: reference.name,
        version: reference.version,
        keptLastGood: reference.keptLastGood,
      });
      try {
        await this.audit.append(
          this.stream,
          managerReferenceRefusedEvent({ environment: this.config.environment, ...reference })
        );
      } catch (error) {
        console.error('sts: refused-reference audit append failed', { reason: errorName(error) });
      }
    }
  }

  private recordFailure(startedAt: number, detail: string, retryAfterMs: number | null): void {
    const failures = this.state(startedAt).failures + 1;
    const delay = backoffDelayMs(failures, retryAfterMs);
    this.db
      .update(schema.refresherState)
      .set({ failures, nextRefreshAt: startedAt + delay })
      .where(eq(schema.refresherState.id, 1))
      .run();
    console.warn('sts: manager read failed; bundle objects keep their copies, marked stale', {
      environment: this.config.environment,
      detail,
      failures,
      retryInMs: Math.round(delay),
    });
  }

  private recordSuccess(startedAt: number): void {
    this.db
      .update(schema.refresherState)
      .set({ failures: 0, nextRefreshAt: startedAt + REFRESH_INTERVAL_MS })
      .where(eq(schema.refresherState.id, 1))
      .run();
  }

  /**
   * Opens a merge window ending `delay` from now, unless one is open, a backoff deadline governs,
   * or the regular refresh comes first. Never less than 30 seconds after the last refresh.
   */
  private requestEarlyRefresh(now: number, delay: number): void {
    const state = this.state(now);
    if (state.failures > 0 || state.webhookRefreshAt !== null) return;
    const at = Math.max(now + delay, (state.lastRefreshAt ?? 0) + WEBHOOK_MERGE_WINDOW_MS);
    if (at >= state.nextRefreshAt) return;
    this.db
      .update(schema.refresherState)
      .set({ webhookRefreshAt: at })
      .where(eq(schema.refresherState.id, 1))
      .run();
  }

  private async pushAll(view: ManagerView, stale: boolean): Promise<void> {
    await Promise.all(
      this.policies.forEnvironment(this.config.environment).map(async policy => {
        const bundle = await this.bundleFor(policy, view, stale);
        try {
          const result = await withDORetry(
            () => getBundleStub(this.env, this.config, policy.workload),
            async stub => await stub.putBundle(bundle),
            'sts.bundle.put'
          );
          if (result.status === 'mismatch') {
            console.error('sts: bundle push addressed the wrong object', {
              workload: policy.workload,
            });
          }
        } catch (error) {
          console.warn('sts: bundle push failed; the object keeps its last copy', {
            workload: policy.workload,
            reason: errorName(error),
          });
        }
      })
    );
  }

  private async bundleFor(
    policy: Policy,
    view: ManagerView,
    stale: boolean
  ): Promise<WorkloadBundle> {
    const folder = bundleFolder(policy);
    const { secrets, missing } = resolveWorkloadSecrets(
      folder.path,
      policy.secrets,
      folder.root === '/ci' ? view.ci : view.workloads,
      view.shared
    );
    return {
      workload: policy.workload,
      secrets,
      missing,
      fetchedAt: new Date(view.fetchedAt).toISOString(),
      policyHash: await this.policies.workloadHash(policy.workload),
      stale,
    };
  }

  private async applyPolicyChange(): Promise<boolean> {
    const hash = await this.policies.hash();
    const state = this.db
      .select()
      .from(schema.policyState)
      .where(eq(schema.policyState.id, 1))
      .get();
    if (state?.hash === hash) return false;

    const previous: PolicySnapshotEntry[] = state ? PolicySnapshotSchema.parse(state.snapshot) : [];
    const current = this.policies.snapshot();
    await this.audit.append(
      this.stream,
      policyChangedEvent({
        environment: this.config.environment,
        policyHash: hash,
        previousPolicyHash: state?.hash ?? null,
        previous,
        current,
      })
    );
    this.db
      .insert(schema.policyState)
      .values({ id: 1, hash, snapshot: current })
      .onConflictDoUpdate({ target: schema.policyState.id, set: { hash, snapshot: current } })
      .run();
    return true;
  }

  private async storedFolders(): Promise<Map<ManagerFolder, StoredFolder>> {
    const rows = this.db.select().from(schema.managerFolder).all();
    const key = rows.length > 0 ? await this.snapshotKey() : null;
    const folders = new Map<ManagerFolder, StoredFolder>();
    for (const row of rows) {
      let copy: FolderCopy | null = null;
      if (key !== null) {
        try {
          const parsed = FolderCopySchema.safeParse(
            await openJson(key, { iv: row.iv, ciphertext: row.ciphertext })
          );
          copy = parsed.success ? parsed.data : null;
        } catch {
          copy = null;
        }
      }
      folders.set(row.folder, { etag: row.etag, fetchedAt: row.fetchedAt, copy });
    }
    return folders;
  }

  /** The last successful read of every folder this environment needs, or null without one. */
  private async storedView(): Promise<ManagerView | null> {
    const stored = await this.storedFolders();
    const copies = new Map<ManagerFolder, FolderCopy>();
    let fetchedAt = Number.POSITIVE_INFINITY;
    for (const folder of this.managerFolders()) {
      const entry = stored.get(folder);
      if (!entry?.copy) return null;
      copies.set(folder, entry.copy);
      fetchedAt = Math.min(fetchedAt, entry.fetchedAt);
    }
    return managerView(copies, fetchedAt);
  }

  private snapshotKey(): Promise<string> {
    if (this.sealKey === null) {
      const pending = loadOrCreateKey({
        storage: this.ctx.storage,
        name: SEAL_KEY_NAME,
        schema: z.string().min(1),
        create: createEncryptionKey,
      });
      this.sealKey = pending;
      pending.catch(() => {
        if (this.sealKey === pending) this.sealKey = null;
      });
    }
    return this.sealKey;
  }

  /**
   * The webhook secret stays in a SQL row, written once: the break-glass owner copies it from Data
   * Studio, which reads SQL data only (README). Its single insert is the one statement that binds
   * it; traces are off (wrangler.jsonc), and a leaked copy could only trigger early refreshes.
   */
  private webhookSecretValue(): string {
    const existing = this.db
      .select()
      .from(schema.webhookKey)
      .where(eq(schema.webhookKey.id, 1))
      .get();
    if (existing !== undefined) return existing.key;
    const key = createEncryptionKey();
    this.db.insert(schema.webhookKey).values({ id: 1, key, createdAt: Date.now() }).run();
    return key;
  }

  /** The schedule row; a new object's first refresh is due at once. */
  private state(now: number): RefresherState {
    const row = this.db
      .select()
      .from(schema.refresherState)
      .where(eq(schema.refresherState.id, 1))
      .get();
    if (row !== undefined) return row;
    const initial: RefresherState = {
      id: 1,
      nextRefreshAt: now,
      failures: 0,
      webhookRefreshAt: null,
      lastRefreshAt: null,
    };
    this.db.insert(schema.refresherState).values(initial).run();
    return initial;
  }

  /** Sets the alarm to the earliest of the refresh and the audit work, unless it is already earlier. */
  private async scheduleAlarm(now: number, relayFailed: boolean): Promise<void> {
    let target = dueAt(this.state(now));
    if (this.audit.hasUnrelayed()) {
      target = Math.min(target, now + (relayFailed ? RELAY_RETRY_MS : RELAY_DELAY_MS));
    } else if (this.audit.hasRows()) {
      target = Math.min(target, this.audit.nextPruneAt());
    }
    target = Math.max(target, now);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }
}
