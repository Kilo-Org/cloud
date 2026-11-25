import { withDORetry } from '@kilocode/worker-utils';
import { WorkloadNameSchema, encodeAuditBatch } from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { and, asc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from '../../drizzle.refresher/migrations';
import { policyChangedEvent } from '../audit/events';
import { relayAudit, type AuditRelayStore } from '../audit/relay';
import {
  PRUNE_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  RELAY_RETRY_MS,
  STARTUP_ALARM_DELAY_MS,
} from '../constants';
import { createEncryptionKey, openJson, sealJson } from '../crypto/aes';
import * as schema from '../db/refresher-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import { InfisicalClient, type ManagerSecret } from '../infisical/client';
import { currentPolicyHash, policiesFor, policyFor, policySnapshot } from '../policy';
import { PolicySnapshotSchema } from '../policy/schema';
import type { PolicySnapshotEntry } from '../policy/load';
import { WorkloadBundleSchema, type WorkloadBundle } from '../types';
import { getBundleStub, getSignerStub } from './stubs';

type RefresherDatabase = DrizzleSqliteDODatabase<typeof schema>;

const ManagerSecretsSchema = z.record(
  z.string(),
  z.object({ value: z.string(), version: z.number().int().nonnegative() })
);

type ManagerReadOutcome =
  | { status: 'ok'; secrets: Record<string, ManagerSecret> }
  | { status: 'unreachable' };

/**
 * One object per environment. Every alarm reads the manager in one bulk request,
 * rebuilds each workload's bundle from policy, and pushes it to that workload's
 * object. It also owns the policy-change audit event and the policy stream relay.
 */
export class RefresherDO extends DurableObject<Env> {
  private readonly config: StsConfig;
  private readonly db: RefresherDatabase;
  private client: InfisicalClient | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    this.db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  /** Starts the alarm loop and records any policy change the last deploy introduced. */
  async ensureStarted(): Promise<void> {
    const changed = await this.applyPolicyChange();
    const now = Date.now();
    if (changed) this.writeState(now);
    const alarm = await this.ctx.storage.getAlarm();
    const target = changed ? now + STARTUP_ALARM_DELAY_MS : this.ensureState(now).nextRefreshAt;
    if (alarm === null || alarm > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  /** Fills one empty bundle object. The caller stores what this returns; it pushes nothing. */
  async buildBundle(workload: string): Promise<WorkloadBundle | null> {
    const name = WorkloadNameSchema.parse(workload);
    if (policyFor(this.config.environment, name) === null) return null;
    const read = await this.readManager();
    if (read.status === 'unreachable') return null;
    return await this.buildBundleFor(name, read.secrets);
  }

  async refreshAll(): Promise<void> {
    await this.applyPolicyChange();
    const workloads = policiesFor(this.config.environment).map(policy => policy.workload);
    const read = await this.readManager();
    if (read.status === 'unreachable') {
      await this.markStale(workloads);
      return;
    }
    for (const workload of workloads) {
      const bundle = await this.buildBundleFor(workload, read.secrets);
      try {
        const result = await withDORetry(
          () => getBundleStub(this.env, this.config, workload),
          stub => stub.putBundle(bundle),
          'sts.bundle.put'
        );
        if (result.status === 'mismatch') {
          console.warn('sts: bundle push addressed the wrong object', { workload });
        }
      } catch (error) {
        console.warn('sts: bundle push failed; the object keeps its last copy', {
          workload,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }

  async alarm(): Promise<void> {
    await this.relayAudit();
    const now = Date.now();
    if (now >= this.ensureState(now).nextRefreshAt) {
      this.writeState(now + REFRESH_INTERVAL_MS);
      await this.refreshAll();
    }
    await this.scheduleNextAlarm();
  }

  private managerClient(): InfisicalClient {
    const existing = this.client;
    if (existing !== null) return existing;
    const client = new InfisicalClient(this.config.manager, () =>
      withDORetry(
        () => getSignerStub(this.env, this.config),
        stub => stub.signManagerToken(),
        'sts.signManagerToken'
      )
    );
    this.client = client;
    return client;
  }

  private async readManager(): Promise<ManagerReadOutcome> {
    const snapshot = this.db
      .select()
      .from(schema.managerSnapshot)
      .where(eq(schema.managerSnapshot.id, 1))
      .get();
    const read = await this.managerClient().read(snapshot?.etag ?? null);

    if (read.status === 'fresh') {
      await this.storeSnapshot(read.secrets, read.etag);
      return { status: 'ok', secrets: read.secrets };
    }
    if (read.status === 'not_modified') {
      const stored = snapshot ? await this.openSnapshot(snapshot) : null;
      if (stored !== null) return { status: 'ok', secrets: stored };
      // The manager says unchanged but this object holds no copy: read it in full.
      const forced = await this.managerClient().read(null);
      if (forced.status === 'fresh') {
        await this.storeSnapshot(forced.secrets, forced.etag);
        return { status: 'ok', secrets: forced.secrets };
      }
    }
    return { status: 'unreachable' };
  }

  private async buildBundleFor(
    workload: string,
    secrets: Record<string, ManagerSecret>
  ): Promise<WorkloadBundle> {
    const policy = policyFor(this.config.environment, workload);
    if (policy === null) throw new Error(`no policy for workload ${workload}`);

    const bundleSecrets: Record<string, ManagerSecret> = {};
    const missing: string[] = [];
    for (const name of policy.secrets) {
      const secret = secrets[name];
      if (secret === undefined) missing.push(name);
      else bundleSecrets[name] = secret;
    }
    return WorkloadBundleSchema.parse({
      workload,
      secrets: bundleSecrets,
      missing,
      fetchedAt: new Date().toISOString(),
      policyHash: await currentPolicyHash(),
    });
  }

  private async markStale(workloads: string[]): Promise<void> {
    for (const workload of workloads) {
      try {
        await withDORetry(
          () => getBundleStub(this.env, this.config, workload),
          stub => stub.markStale(),
          'sts.bundle.markStale'
        );
      } catch (error) {
        console.warn('sts: stale marking failed', {
          workload,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }

  private async applyPolicyChange(): Promise<boolean> {
    const hash = await currentPolicyHash();
    const state = this.db
      .select()
      .from(schema.policyState)
      .where(eq(schema.policyState.id, 1))
      .get();
    if (state?.hash === hash) return false;

    const previous: PolicySnapshotEntry[] = state ? PolicySnapshotSchema.parse(state.snapshot) : [];
    const current = policySnapshot();
    const event = policyChangedEvent({
      environment: this.config.environment,
      policyHash: hash,
      previousPolicyHash: state?.hash ?? null,
      previous,
      current,
    });
    this.db.insert(schema.auditEvent).values({ event, createdAt: Date.now() }).run();
    this.db
      .insert(schema.policyState)
      .values({ id: 1, hash, snapshot: current })
      .onConflictDoUpdate({ target: schema.policyState.id, set: { hash, snapshot: current } })
      .run();
    return true;
  }

  private snapshotKey(): string {
    const existing = this.db
      .select()
      .from(schema.refresherKey)
      .where(eq(schema.refresherKey.id, 1))
      .get();
    if (existing !== undefined) return existing.key;
    const key = createEncryptionKey();
    this.db
      .insert(schema.refresherKey)
      .values({ id: 1, key, createdAt: Date.now() })
      .onConflictDoUpdate({ target: schema.refresherKey.id, set: { key } })
      .run();
    return key;
  }

  private async storeSnapshot(
    secrets: Record<string, ManagerSecret>,
    etag: string | null
  ): Promise<void> {
    const sealed = await sealJson(this.snapshotKey(), secrets);
    const fetchedAt = new Date().toISOString();
    this.db
      .insert(schema.managerSnapshot)
      .values({ id: 1, etag, fetchedAt, iv: sealed.iv, ciphertext: sealed.ciphertext })
      .onConflictDoUpdate({
        target: schema.managerSnapshot.id,
        set: { etag, fetchedAt, iv: sealed.iv, ciphertext: sealed.ciphertext },
      })
      .run();
  }

  private async openSnapshot(
    row: typeof schema.managerSnapshot.$inferSelect
  ): Promise<Record<string, ManagerSecret> | null> {
    const key = this.db
      .select()
      .from(schema.refresherKey)
      .where(eq(schema.refresherKey.id, 1))
      .get()?.key;
    if (key === undefined) return null;
    try {
      const parsed = ManagerSecretsSchema.safeParse(
        await openJson(key, { iv: row.iv, ciphertext: row.ciphertext })
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private ensureState(now: number): { nextRefreshAt: number } {
    const row = this.db
      .select()
      .from(schema.refresherState)
      .where(eq(schema.refresherState.id, 1))
      .get();
    if (row !== undefined) return { nextRefreshAt: row.nextRefreshAt };
    this.db.insert(schema.refresherState).values({ id: 1, nextRefreshAt: now }).run();
    return { nextRefreshAt: now };
  }

  private writeState(nextRefreshAt: number): void {
    this.db
      .insert(schema.refresherState)
      .values({ id: 1, nextRefreshAt })
      .onConflictDoUpdate({ target: schema.refresherState.id, set: { nextRefreshAt } })
      .run();
  }

  private watermark(): number {
    return (
      this.db.select().from(schema.auditWatermark).where(eq(schema.auditWatermark.id, 1)).get()
        ?.relayedSeq ?? 0
    );
  }

  private auditStore(): AuditRelayStore {
    return {
      nextRows: (afterSeq, limit) =>
        this.db
          .select()
          .from(schema.auditEvent)
          .where(gt(schema.auditEvent.seq, afterSeq))
          .orderBy(asc(schema.auditEvent.seq))
          .limit(limit)
          .all(),
      watermark: () => this.watermark(),
      advanceWatermark: toSeq => {
        this.db
          .insert(schema.auditWatermark)
          .values({ id: 1, relayedSeq: toSeq })
          .onConflictDoUpdate({ target: schema.auditWatermark.id, set: { relayedSeq: toSeq } })
          .run();
      },
      prune: olderThanMs => {
        const watermark = this.watermark();
        if (watermark === 0) return;
        this.db
          .delete(schema.auditEvent)
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

  private async relayAudit(): Promise<void> {
    try {
      const result = await relayAudit({
        store: this.auditStore(),
        stream: `sts:${this.config.environment}:policy`,
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
      console.warn('sts: policy audit relay failed; rows stay for the next alarm', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    let next = this.ensureState(now).nextRefreshAt;
    if (this.countAuditRows(this.watermark()) > 0) {
      next = Math.min(next, now + RELAY_RETRY_MS);
    } else if (this.countAuditRows(null) > 0) {
      next = Math.min(next, now + PRUNE_INTERVAL_MS);
    }
    await this.ctx.storage.setAlarm(Math.max(now + 1_000, next));
  }
}
