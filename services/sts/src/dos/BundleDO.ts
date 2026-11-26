import { withDORetry } from '@kilocode/worker-utils';
import {
  BundleRequestSchema,
  type BundleRequest,
  type BundleResult,
  type BundleSecret,
} from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { eq, lt, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from '../../drizzle.bundle/migrations';
import { bundleDeliveredEvent } from '../audit/events';
import { AuditLog } from '../audit/log';
import { computeBundleEtag } from '../bundle/etag';
import {
  AUDIT_RETRY_AFTER_SECONDS,
  DELIVERY_COUNTER_RETENTION_MS,
  MANAGER_RETRY_AFTER_SECONDS,
  STALE_AFTER_MS,
  REFRESHER_CHECK_INTERVAL_MS,
  RELAY_DELAY_MS,
  RELAY_RETRY_MS,
} from '../constants';
import { createEncryptionKey, openJson, sealJson } from '../crypto/aes';
import { loadOrCreateKey } from '../crypto/key-store';
import * as schema from '../db/bundle-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import { GithubRunSchema, type GithubRun } from '../identity/verify';
import { policyIndex } from '../policy';
import type { PolicyIndex } from '../policy/load';
import type { Policy } from '../policy/schema';
import {
  BundleSecretsSchema,
  BundleTargetSchema,
  WorkloadBundleSchema,
  type BundleSecrets,
  type PutBundleResult,
  type WorkloadBundle,
} from '../types';
import { getBundleStub, getRefresherStub } from './stubs';

type BundleDatabase = DrizzleSqliteDODatabase<typeof schema>;
type BundleRow = typeof schema.bundle.$inferSelect;
type BundleKeys = { sealKey: string; etagKey: string };

/** KV storage key of the seal and ETag keys (see `crypto/key-store.ts`). */
const BUNDLE_KEYS_NAME = 'bundle-keys';

const BundleKeysSchema = z.strictObject({
  sealKey: z.string().min(1),
  etagKey: z.string().min(1),
});

/**
 * What a read serves: the stored bundle, or, when the stored copy was built under another policy,
 * that copy cut down to the current grants with its ETag and missing list recomputed.
 */
type ServedBundle =
  | { kind: 'stored'; row: BundleRow }
  | { kind: 'narrowed'; row: BundleRow; etag: string; secrets: BundleSecrets; missing: string[] };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function utcMinute(time: number): string {
  return new Date(time).toISOString().slice(0, 16);
}

/**
 * One object per environment and workload. It holds the workload's bundle sealed with a key it
 * generated itself, and it appends the delivery audit row in the same call that hands the bundle
 * out. Callers do not retry a delivery: a retry after a committed append would audit twice.
 */
export class BundleDO extends DurableObject<Env> {
  /** The policies this object serves; a test fixture's subclass sets its own. */
  static readonly policies: PolicyIndex = policyIndex;

  private readonly config: StsConfig;
  private readonly db: BundleDatabase;
  private readonly audit: AuditLog;
  // An instance field, not a method: RPC exposes prototype methods, never instance fields.
  private readonly policies: PolicyIndex;
  private keys: Promise<BundleKeys> | null = null;
  private pendingFill: Promise<BundleRow | null> | null = null;
  private refresherCheckedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    this.policies = new.target.policies;
    this.db = drizzle(ctx.storage, { schema });
    this.audit = new AuditLog(ctx.storage, env.AUDIT_QUEUE);
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  async getBundle(
    workload: string,
    environment: string,
    request: BundleRequest,
    run: GithubRun | null = null
  ): Promise<BundleResult> {
    const target = BundleTargetSchema.parse({ workload, environment });
    const ifNoneMatch = BundleRequestSchema.parse(request).ifNoneMatch;
    // RPC hands over whatever the caller sent; the broker sends a verified token's run, so
    // anything else is a bug, refused before it can reach the delivery row.
    const parsedRun = GithubRunSchema.nullable().safeParse(run);
    if (!parsedRun.success) {
      console.error('sts: malformed GitHub run at the bundle boundary; the read is refused', {
        workload: target.workload,
      });
      return {
        status: 'unavailable',
        reason: 'internal',
        retryAfterSeconds: AUDIT_RETRY_AFTER_SECONDS,
      };
    }

    if (target.environment !== this.config.environment) {
      return { status: 'denied', reason: 'environment_mismatch' };
    }
    if (!this.ctx.id.equals(getBundleStub(this.env, this.config, target.workload).id)) {
      // Addressed by a name that is not this workload's: refuse rather than serve another bundle.
      return {
        status: 'unavailable',
        reason: 'internal',
        retryAfterSeconds: AUDIT_RETRY_AFTER_SECONDS,
      };
    }
    const policy = this.policies.get(this.config.environment, target.workload);
    if (policy === null) {
      return {
        status: 'denied',
        reason: this.policies.has(target.workload) ? 'environment_mismatch' : 'unknown_workload',
      };
    }
    this.checkRefresher();

    const row = this.readBundle() ?? (await this.fill(target.workload));
    if (row === null) {
      return {
        status: 'unavailable',
        reason: 'manager_unreachable_no_copy',
        retryAfterSeconds: MANAGER_RETRY_AFTER_SECONDS,
      };
    }

    const served = await this.serve(row, policy);
    if (served === null) {
      return {
        status: 'unavailable',
        reason: 'internal',
        retryAfterSeconds: MANAGER_RETRY_AFTER_SECONDS,
      };
    }
    const etag = served.kind === 'stored' ? served.row.etag : served.etag;
    // A copy whose pushes keep failing is stale even though no failed read marked it.
    const stale = row.stale || Date.now() - Date.parse(row.fetchedAt) > STALE_AFTER_MS;
    if (ifNoneMatch === etag) {
      this.recordNotModified();
      return { status: 'not_modified', etag, stale, fetchedAt: row.fetchedAt };
    }

    const secrets = served.kind === 'stored' ? await this.open(row) : served.secrets;
    if (secrets === null) {
      return {
        status: 'unavailable',
        reason: 'internal',
        retryAfterSeconds: MANAGER_RETRY_AFTER_SECONDS,
      };
    }
    const missing = served.kind === 'stored' ? row.missing : served.missing;
    try {
      await this.audit.append(
        this.stream(target.workload),
        bundleDeliveredEvent({
          environment: this.config.environment,
          workload: target.workload,
          etag,
          stale,
          secrets: Object.entries(secrets).map(([name, secret]) => ({
            name,
            version: secret.version,
          })),
          missing,
          run: parsedRun.data,
        })
      );
    } catch (error) {
      console.error('sts: delivery audit append failed; the read is refused', {
        workload: target.workload,
        reason: errorName(error),
      });
      return {
        status: 'unavailable',
        reason: 'audit_write_failed',
        retryAfterSeconds: AUDIT_RETRY_AFTER_SECONDS,
      };
    }
    await this.scheduleRelay();

    const delivered: Record<string, BundleSecret> = {};
    for (const [name, secret] of Object.entries(secrets)) {
      delivered[name] = { value: secret.value, version: secret.version };
    }
    return {
      status: 'ok',
      workload: target.workload,
      environment: this.config.environment,
      etag,
      stale,
      fetchedAt: row.fetchedAt,
      secrets: delivered,
      missing,
    };
  }

  /** Called by the refresher. An unchanged ETag rewrites freshness and the stale flag only. */
  async putBundle(raw: WorkloadBundle): Promise<PutBundleResult> {
    const bundle = WorkloadBundleSchema.parse(raw);
    if (!this.ctx.id.equals(getBundleStub(this.env, this.config, bundle.workload).id)) {
      // Addressed by a name that is not this workload's: refuse rather than store another bundle.
      return { status: 'mismatch' };
    }
    const { row, changed } = await this.writeBundle(bundle);
    return { status: 'stored', changed, etag: row.etag };
  }

  async alarm(): Promise<void> {
    const row = this.readBundle();
    let relayFailed = false;
    if (row !== null) {
      try {
        await this.audit.relay(this.stream(row.workload));
      } catch (error) {
        relayFailed = true;
        console.warn('sts: bundle audit relay failed; rows stay for the next alarm', {
          workload: row.workload,
          reason: errorName(error),
        });
      }
    }
    const now = Date.now();
    if (now >= this.audit.nextPruneAt()) {
      this.db
        .delete(schema.deliveryCounter)
        .where(lt(schema.deliveryCounter.minute, utcMinute(now - DELIVERY_COUNTER_RETENTION_MS)))
        .run();
    }
    this.audit.pruneIfDue(now);
    await this.scheduleNextAlarm(Date.now(), relayFailed);
  }

  /**
   * Asks the refresher to confirm its alarm loop, at most once a minute and off the read path, so
   * a refresher that lost its alarm restarts within a minute of the next read.
   */
  private checkRefresher(): void {
    const now = Date.now();
    if (now - this.refresherCheckedAt < REFRESHER_CHECK_INTERVAL_MS) return;
    this.refresherCheckedAt = now;
    this.ctx.waitUntil(
      withDORetry(
        () => getRefresherStub(this.env, this.config),
        stub => stub.ensureStarted(),
        'sts.ensureStarted'
      ).catch((error: unknown) => {
        console.warn('sts: refresher check failed', { reason: errorName(error) });
      })
    );
  }

  /** Concurrent reads of an empty object share one fill. */
  private fill(workload: string): Promise<BundleRow | null> {
    if (this.pendingFill !== null) return this.pendingFill;
    const pending = this.performFill(workload).finally(() => {
      this.pendingFill = null;
    });
    this.pendingFill = pending;
    return pending;
  }

  private async performFill(workload: string): Promise<BundleRow | null> {
    try {
      const result = await withDORetry(
        () => getRefresherStub(this.env, this.config),
        async stub => await stub.buildBundle(workload),
        'sts.bundle.fill'
      );
      if (result.status !== 'built') return null;
      return (await this.writeBundle(result.bundle)).row;
    } catch (error) {
      console.warn('sts: bundle fill failed', { workload, reason: errorName(error) });
      return null;
    }
  }

  /**
   * A stored copy built under the current policy serves as is. One built under another policy, for
   * example during a manager outage after a deploy, is cut down to the current grants first, so a
   * removed grant is never served (design 4.4: STS refuses any read the policy does not list).
   */
  private async serve(row: BundleRow, policy: Policy): Promise<ServedBundle | null> {
    const policyHash = await this.policies.workloadHash(policy.workload);
    if (row.policyHash === policyHash) return { kind: 'stored', row };
    const stored = await this.open(row);
    if (stored === null) return null;
    const secrets: BundleSecrets = {};
    const missing: string[] = [];
    for (const name of policy.secrets) {
      const secret = stored[name];
      if (secret === undefined) missing.push(name);
      else secrets[name] = secret;
    }
    const etag = await computeBundleEtag(
      (await this.bundleKeys()).etagKey,
      policyHash,
      secrets,
      missing
    );
    return { kind: 'narrowed', row, etag, secrets, missing };
  }

  private readBundle(): BundleRow | null {
    return this.db.select().from(schema.bundle).where(eq(schema.bundle.id, 1)).get() ?? null;
  }

  private async writeBundle(bundle: WorkloadBundle): Promise<{ row: BundleRow; changed: boolean }> {
    const keys = await this.bundleKeys();
    const etag = await computeBundleEtag(
      keys.etagKey,
      bundle.policyHash,
      bundle.secrets,
      bundle.missing
    );
    const existing = this.readBundle();
    if (existing !== null && existing.etag === etag) {
      this.db
        .update(schema.bundle)
        .set({ fetchedAt: bundle.fetchedAt, stale: bundle.stale })
        .where(eq(schema.bundle.id, 1))
        .run();
      return {
        row: { ...existing, fetchedAt: bundle.fetchedAt, stale: bundle.stale },
        changed: false,
      };
    }

    const sealed = await sealJson(keys.sealKey, bundle.secrets);
    const values: BundleRow = {
      id: 1,
      workload: bundle.workload,
      environment: this.config.environment,
      etag,
      policyHash: bundle.policyHash,
      fetchedAt: bundle.fetchedAt,
      stale: bundle.stale,
      missing: bundle.missing,
      iv: sealed.iv,
      ciphertext: sealed.ciphertext,
    };
    this.db
      .insert(schema.bundle)
      .values(values)
      .onConflictDoUpdate({
        target: schema.bundle.id,
        set: {
          workload: values.workload,
          environment: values.environment,
          etag: values.etag,
          policyHash: values.policyHash,
          fetchedAt: values.fetchedAt,
          stale: values.stale,
          missing: values.missing,
          iv: values.iv,
          ciphertext: values.ciphertext,
        },
      })
      .run();
    return { row: values, changed: true };
  }

  private async open(row: BundleRow): Promise<BundleSecrets | null> {
    try {
      const parsed = BundleSecretsSchema.safeParse(
        await openJson((await this.bundleKeys()).sealKey, {
          iv: row.iv,
          ciphertext: row.ciphertext,
        })
      );
      if (parsed.success) return parsed.data;
    } catch {
      // Reported below; the cause can carry no secret material.
    }
    console.error('sts: stored bundle could not be opened', { workload: row.workload });
    return null;
  }

  private bundleKeys(): Promise<BundleKeys> {
    if (this.keys === null) {
      const pending = loadOrCreateKey({
        storage: this.ctx.storage,
        name: BUNDLE_KEYS_NAME,
        schema: BundleKeysSchema,
        create: () => ({ sealKey: createEncryptionKey(), etagKey: createEncryptionKey() }),
      });
      this.keys = pending;
      pending.catch(() => {
        if (this.keys === pending) this.keys = null;
      });
    }
    return this.keys;
  }

  private stream(workload: string): string {
    return `sts:${this.config.environment}:bundle:${workload}`;
  }

  private recordNotModified(): void {
    this.db
      .insert(schema.deliveryCounter)
      .values({ minute: utcMinute(Date.now()), count: 1 })
      .onConflictDoUpdate({
        target: schema.deliveryCounter.minute,
        set: { count: sql`${schema.deliveryCounter.count} + 1` },
      })
      .run();
  }

  private async scheduleRelay(): Promise<void> {
    try {
      const now = Date.now();
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > now + RELAY_DELAY_MS) {
        await this.ctx.storage.setAlarm(now + RELAY_DELAY_MS);
      }
    } catch (error) {
      // The row is committed; the next delivery or alarm relays it.
      console.warn('sts: relay alarm could not be set', { reason: errorName(error) });
    }
  }

  private async scheduleNextAlarm(now: number, relayFailed: boolean): Promise<void> {
    const audit = this.audit;
    if (audit.hasUnrelayed()) {
      await this.ctx.storage.setAlarm(now + (relayFailed ? RELAY_RETRY_MS : RELAY_DELAY_MS));
      return;
    }
    const counters =
      this.db
        .select({ minute: schema.deliveryCounter.minute })
        .from(schema.deliveryCounter)
        .limit(1)
        .get() !== undefined;
    if (audit.hasRows() || counters) {
      await this.ctx.storage.setAlarm(Math.max(now + 1_000, audit.nextPruneAt()));
    }
  }
}
