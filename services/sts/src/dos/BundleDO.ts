import { withDORetry } from '@kilocode/worker-utils';
import {
  BundleRequestSchema,
  SecretNameSchema,
  encodeAuditBatch,
  type BundleRequest,
  type BundleResult,
} from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { and, asc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from '../../drizzle.bundle/migrations';
import { bundleDeliveredEvent } from '../audit/events';
import { relayAudit, type AuditRelayStore } from '../audit/relay';
import { computeBundleEtag } from '../bundle/etag';
import {
  AUDIT_RETRY_AFTER_SECONDS,
  MANAGER_RETRY_AFTER_SECONDS,
  PRUNE_INTERVAL_MS,
  RELAY_RETRY_MS,
} from '../constants';
import { createEncryptionKey, openJson, sealJson } from '../crypto/aes';
import * as schema from '../db/bundle-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import { policyExists, policyFor } from '../policy';
import {
  BundleTargetSchema,
  WorkloadBundleSchema,
  type PutBundleResult,
  type WorkloadBundle,
} from '../types';
import { getBundleStub, getRefresherStub } from './stubs';

type BundleDatabase = DrizzleSqliteDODatabase<typeof schema>;
type BundleRow = typeof schema.bundle.$inferSelect;

const BundleSecrets = z.record(
  SecretNameSchema,
  z.object({ value: z.string(), version: z.number().int().nonnegative() })
);

const RELAY_DELAY_MS = 5_000;

/**
 * One object per environment and workload. It holds the workload's bundle sealed
 * with a key it generated itself, and it appends the delivery audit row in the same
 * call that hands the bundle out. Retrying a delivery is deliberately not attempted
 * by the caller's DO helper: a retry after a committed append would audit twice.
 */
export class BundleDO extends DurableObject<Env> {
  private readonly config: StsConfig;
  private readonly db: BundleDatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    this.db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  async getBundle(
    workload: string,
    environment: string,
    request: BundleRequest
  ): Promise<BundleResult> {
    const target = BundleTargetSchema.parse({ workload, environment });
    const ifNoneMatch = BundleRequestSchema.parse(request).ifNoneMatch;

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
    if (policyFor(this.config.environment, target.workload) === null) {
      return {
        status: 'denied',
        reason: policyExists(target.workload) ? 'environment_mismatch' : 'unknown_workload',
      };
    }

    let row = this.readBundle();
    if (row === null) {
      row = await this.fill(target.workload);
      if (row === null) {
        return {
          status: 'unavailable',
          reason: 'manager_unreachable_no_copy',
          retryAfterSeconds: MANAGER_RETRY_AFTER_SECONDS,
        };
      }
    }

    if (ifNoneMatch === row.etag) {
      this.recordNotModified();
      return { status: 'not_modified', etag: row.etag, stale: row.stale, fetchedAt: row.fetchedAt };
    }

    const secrets = await this.openBundle(row);
    if (secrets === null) {
      return {
        status: 'unavailable',
        reason: 'internal',
        retryAfterSeconds: MANAGER_RETRY_AFTER_SECONDS,
      };
    }
    if (!this.appendDelivery(row, secrets)) {
      return {
        status: 'unavailable',
        reason: 'audit_write_failed',
        retryAfterSeconds: AUDIT_RETRY_AFTER_SECONDS,
      };
    }
    await this.ensureRelayScheduled();

    return {
      status: 'ok',
      workload: target.workload,
      environment: this.config.environment,
      etag: row.etag,
      stale: row.stale,
      fetchedAt: row.fetchedAt,
      secrets,
      missing: row.missing,
    };
  }

  /** Called by the refresher. An unchanged ETag rewrites freshness only. */
  async putBundle(raw: WorkloadBundle): Promise<PutBundleResult> {
    const bundle = WorkloadBundleSchema.parse(raw);
    if (!this.ctx.id.equals(getBundleStub(this.env, this.config, bundle.workload).id)) {
      // Addressed by a name that is not this workload's: refuse rather than store another bundle.
      return { status: 'mismatch', changed: false, etag: '' };
    }
    const { row, changed } = await this.writeBundle(bundle);
    return { status: 'stored', changed, etag: row.etag };
  }

  /** Called by the refresher after a failed manager read: keep the copy, mark it stale. */
  async markStale(): Promise<void> {
    this.db.update(schema.bundle).set({ stale: true }).where(eq(schema.bundle.id, 1)).run();
  }

  async alarm(): Promise<void> {
    const row = this.readBundle();
    if (row === null) return;
    try {
      const result = await relayAudit({
        store: this.auditStore(),
        stream: `sts:${this.config.environment}:bundle:${row.workload}`,
        send: async batch => {
          const bytes = await encodeAuditBatch(batch);
          await this.env.AUDIT_QUEUE.send(bytes, { contentType: 'bytes' });
        },
        now: Date.now(),
      });
      for (const seq of result.skipped) {
        console.warn('sts: audit event dropped: above the message size limit', { seq });
      }
    } catch (error) {
      console.warn('sts: audit relay failed; rows stay for the next alarm', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
    await this.scheduleNextAlarm();
  }

  private readBundle(): BundleRow | null {
    return this.db.select().from(schema.bundle).where(eq(schema.bundle.id, 1)).get() ?? null;
  }

  private async fill(workload: string): Promise<BundleRow | null> {
    let built: WorkloadBundle | null;
    try {
      built = await withDORetry(
        () => getRefresherStub(this.env, this.config),
        stub => stub.buildBundle(workload),
        'sts.bundle.fill'
      );
    } catch {
      return null;
    }
    if (built === null) return null;
    return (await this.writeBundle(built)).row;
  }

  private async writeBundle(bundle: WorkloadBundle): Promise<{ row: BundleRow; changed: boolean }> {
    const versions: Record<string, number> = {};
    for (const [name, secret] of Object.entries(bundle.secrets)) {
      versions[name] = secret.version;
    }
    const etag = await computeBundleEtag(bundle.policyHash, versions);
    const existing = this.readBundle();
    if (existing !== null && existing.etag === etag) {
      this.db
        .update(schema.bundle)
        .set({ fetchedAt: bundle.fetchedAt, stale: false })
        .where(eq(schema.bundle.id, 1))
        .run();
      return { row: { ...existing, fetchedAt: bundle.fetchedAt, stale: false }, changed: false };
    }

    const sealed = await sealJson(this.encryptionKey(), bundle.secrets);
    const values: BundleRow = {
      id: 1,
      workload: bundle.workload,
      environment: this.config.environment,
      etag,
      policyHash: bundle.policyHash,
      fetchedAt: bundle.fetchedAt,
      stale: false,
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

  private async openBundle(row: BundleRow): Promise<z.infer<typeof BundleSecrets> | null> {
    const key = this.db
      .select()
      .from(schema.bundleKey)
      .where(eq(schema.bundleKey.id, 1))
      .get()?.key;
    if (key === undefined) return null;
    try {
      const parsed = BundleSecrets.safeParse(
        await openJson(key, { iv: row.iv, ciphertext: row.ciphertext })
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private encryptionKey(): string {
    const existing = this.db
      .select()
      .from(schema.bundleKey)
      .where(eq(schema.bundleKey.id, 1))
      .get();
    if (existing !== undefined) return existing.key;
    const key = createEncryptionKey();
    this.db
      .insert(schema.bundleKey)
      .values({ id: 1, key, createdAt: Date.now() })
      .onConflictDoUpdate({ target: schema.bundleKey.id, set: { key } })
      .run();
    return key;
  }

  private appendDelivery(
    row: BundleRow,
    secrets: Record<string, { value: string; version: number }>
  ): boolean {
    try {
      const event = bundleDeliveredEvent({
        environment: this.config.environment,
        workload: row.workload,
        etag: row.etag,
        stale: row.stale,
        secrets: Object.entries(secrets).map(([name, secret]) => ({
          name,
          version: secret.version,
        })),
        missing: row.missing,
      });
      this.db.insert(schema.auditEvent).values({ event, createdAt: Date.now() }).run();
      return true;
    } catch {
      return false;
    }
  }

  private recordNotModified(): void {
    const minute = new Date().toISOString().slice(0, 16);
    this.db
      .insert(schema.deliveryCounter)
      .values({ minute, count: 1 })
      .onConflictDoUpdate({
        target: schema.deliveryCounter.minute,
        set: { count: sql`${schema.deliveryCounter.count} + 1` },
      })
      .run();
  }

  private watermark(): number {
    return (
      this.db.select().from(schema.auditWatermark).where(eq(schema.auditWatermark.id, 1)).get()
        ?.relayedSeq ?? 0
    );
  }

  private auditStore(): AuditRelayStore {
    const db = this.db;
    return {
      nextRows: (afterSeq, limit) =>
        db
          .select()
          .from(schema.auditEvent)
          .where(gt(schema.auditEvent.seq, afterSeq))
          .orderBy(asc(schema.auditEvent.seq))
          .limit(limit)
          .all(),
      watermark: () => this.watermark(),
      advanceWatermark: toSeq => {
        db.insert(schema.auditWatermark)
          .values({ id: 1, relayedSeq: toSeq })
          .onConflictDoUpdate({
            target: schema.auditWatermark.id,
            set: { relayedSeq: toSeq },
          })
          .run();
      },
      prune: olderThanMs => {
        const watermark = this.watermark();
        if (watermark === 0) return;
        db.delete(schema.auditEvent)
          .where(
            and(lt(schema.auditEvent.createdAt, olderThanMs), lte(schema.auditEvent.seq, watermark))
          )
          .run();
      },
    };
  }

  private countAuditRows(afterSeq: number | null): number {
    const query = this.db.select({ count: sql<number>`count(*)` }).from(schema.auditEvent);
    const row =
      afterSeq === null ? query.get() : query.where(gt(schema.auditEvent.seq, afterSeq)).get();
    return row?.count ?? 0;
  }

  private async ensureRelayScheduled(): Promise<void> {
    try {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now() + RELAY_RETRY_MS) {
        await this.ctx.storage.setAlarm(Date.now() + RELAY_DELAY_MS);
      }
    } catch {
      // The row is committed; the next delivery or the prune alarm relays it.
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (this.countAuditRows(this.watermark()) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + RELAY_RETRY_MS);
      return;
    }
    if (this.countAuditRows(null) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }
}
