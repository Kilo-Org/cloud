import { env, reset, runInDurableObject } from 'cloudflare:test';
import {
  FUNDED_CONTAINER_MINIMUM_MICRODOLLARS,
  LOW_BALANCE_CONTAINER_LIMIT,
  ORGANIZATION_CONTAINER_LIMIT,
  getBillingContext,
  updateBillingContext,
  intervalId,
  usageContextFingerprint,
  createContainerUsageClient,
  installBillingHeartbeat,
  type BillingActor,
  type BillingSubject,
  type UsageContext,
} from '@kilocode/container-usage';
import { readContainerCapacity } from '@kilocode/container-usage/capacity';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cloud_billing_sku,
  container_usage_interval,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  parseSandboxBillingInput,
  vercelBillingIdentity,
  SANDBOX_USAGE_SKUS,
  usageServiceForSandboxClass,
} from '../../src/container-usage-context.js';
import type {
  EnsureAllocationInput,
  SandboxControlV2,
} from '../../src/control-plane/sandbox/sandbox-do.js';
import type { ProviderAdapter, ProviderCreateIntent } from '../../src/sandbox-control/provider.js';
import { ProviderCreationError } from '../../src/sandbox-control/provider.js';
import { AgentSandboxUnavailableError } from '../../src/agent-sandbox/protocol.js';
import type { VercelBillingLifetimeEvidence } from '../../src/control-plane/sandbox/vercel-billing-runtime.js';
import {
  VERCEL_BILLING_SCHEDULE_KEY,
  type BillingScheduleEntries,
  type BillingScheduleTable,
} from '../../src/sandbox-control/billing-schedule.js';
import { VERCEL_BILLING_SETTLEMENT_CALLBACK } from '../../src/sandbox-control/vercel-billing.js';
import { encodeVercelProviderRef } from '../../src/sandbox-control/vercel-provider.js';
import type { Env } from '../../src/types.js';
import { MeteredBillingLifecycle } from '../../src/metered-billing-lifecycle.js';
import { VERCEL_CREATE_SETTLE_MS } from '../../src/agent-sandbox/vercel/vercel-runtime-state.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import { waitFor } from '../integration/wait-for.js';

const bindings = env as Pick<Env, 'HYPERDRIVE' | 'CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED'> & {
  SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2>;
};
const resources = { vcpus: 2, memory: 4096 } as const;
const ATTEMPTS = 6;

function fakePhysicalProvider(runsOnCreate = true) {
  const creates: Array<{
    intent: ProviderCreateIntent;
    release: () => void;
    fail: (error: Error) => void;
  }> = [];
  const pending = new Set<string>();
  const running = new Set<string>();
  const launches: string[] = [];
  const adapter: ProviderAdapter = {
    async ensureBillingAdmission() {},
    async create(intent) {
      const providerRef = `admission_${intent.intentId}`;
      pending.add(providerRef);
      return new Promise((resolve, reject) => {
        creates.push({
          intent,
          release() {
            pending.delete(providerRef);
            if (runsOnCreate) running.add(providerRef);
            resolve({ providerRef });
          },
          fail(error) {
            pending.delete(providerRef);
            reject(error);
          },
        });
      });
    },
    async launch(ref) {
      launches.push(ref);
      return { startSource: 'image' };
    },
    async observe(ref) {
      return ref === null ? { status: 'unknown' } : { status: 'active', providerRef: ref };
    },
    async stop(ref) {
      if (ref !== null) running.delete(ref);
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return { adapter, creates, pending, running, launches };
}

type Race = {
  scope: 'personal' | 'cross-org-actor' | 'organization';
  slots: number;
  outcome?:
    | 'definite-failure'
    | 'ambiguous-failure'
    | 'recovered-terminal'
    | 'ambiguous-timeout'
    | 'cloudflare-launch-failure';
};

async function runRace(race: Race) {
  const cloudflareLaunchFailure = race.outcome === 'cloudflare-launch-failure';
  const identity = cloudflareLaunchFailure
    ? { service: usageServiceForSandboxClass('Sandbox'), sku: SANDBOX_USAGE_SKUS.Sandbox }
    : vercelBillingIdentity(resources);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const users = Array.from({ length: 4 }, (_, index) => `oauth/admission-${suffix}-${index}`);
  const orgs = [crypto.randomUUID(), crypto.randomUUID()];
  const actor: BillingActor = { type: 'user', id: users[0] };
  const personal: BillingSubject = { type: 'user', id: users[0] };
  const organization: BillingSubject = { type: 'org', id: orgs[0] };
  const memberActors: BillingActor[] = users.map((id, index) => ({
    type: index < 2 ? 'user' : 'bot',
    id,
  }));
  const db = createDrizzleClient({
    connectionString: bindings.HYPERDRIVE.connectionString,
    poolConfig: { max: 3, statement_timeout: 10_000, connectionTimeoutMillis: 5_000 },
  });
  const observer = await db.pool.connect();
  const gate = await db.pool.connect();
  const triggerName = `admission_gate_${suffix}`;
  const gateKey = `admission-test:${suffix}`;
  let gateHeld = false;
  let createdSku = false;
  const attempts = Array.from({ length: ATTEMPTS }, (_, index) => {
    const sandboxId = `ses-${suffix}${index.toString(16).padStart(16, '0')}`;
    const attemptActor =
      race.scope === 'organization' ? memberActors[index % memberActors.length] : actor;
    const subject =
      race.scope === 'organization'
        ? organization
        : race.scope === 'cross-org-actor' && index % 3 !== 0
          ? { type: 'org' as const, id: orgs[(index % 3) - 1] }
          : personal;
    const billing = parseSandboxBillingInput({
      sandboxId,
      subject,
      actor: attemptActor,
      ...(attemptActor.type === 'bot' ? { onBehalfOf: subject } : {}),
      sessionId: `workspace_${crypto.randomUUID()}`,
      metadata: { origin: 'cloud-agent' },
    });
    return {
      sandboxId,
      subject,
      actor: attemptActor,
      owner: attemptActor.type === 'user' ? attemptActor.id : users[index % 2],
      stub: bindings.SANDBOX_CONTROL.getByName(sandboxId),
      provider: fakePhysicalProvider(!cloudflareLaunchFailure),
      input: {
        ...(cloudflareLaunchFailure
          ? { provider: 'cloudflare' as const }
          : {
              provider: 'vercel' as const,
              configuration: { provider: 'vercel' as const, resources },
            }),
        allocationName: sandboxId,
        billing,
      } satisfies EnsureAllocationInput,
    };
  });
  const seededInstanceIds: string[] = [];
  const attemptIds = attempts.map(attempt => attempt.sandboxId);
  const physicalCounts = () => ({
    pending: attempts.reduce((sum, attempt) => sum + attempt.provider.pending.size, 0),
    running: attempts.reduce((sum, attempt) => sum + attempt.provider.running.size, 0),
    creates: attempts.reduce((sum, attempt) => sum + attempt.provider.creates.length, 0),
    launches: attempts.reduce((sum, attempt) => sum + attempt.provider.launches.length, 0),
  });
  const readAttemptRows = () =>
    observer.query<{
      id: string;
      instance_id: string;
      metadata: Record<string, string>;
      status: string;
      start_epoch_ms: string;
      confirmed_seconds: number;
      settled_billable_seconds: number;
    }>(
      'SELECT id, instance_id, metadata, status, start_epoch_ms, confirmed_seconds, settled_billable_seconds FROM container_usage_interval WHERE instance_id = ANY($1::text[]) ORDER BY instance_id',
      [attemptIds]
    );
  try {
    expect(bindings.CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED).toBe('false');
    const insertedSkus = await db.db
      .insert(cloud_billing_sku)
      .values({
        id: identity.sku,
        name: 'Atomic admission fixture',
        unit: 'second',
        rate_cents_per_unit: '0.000001',
      })
      .onConflictDoNothing()
      .returning({ id: cloud_billing_sku.id });
    createdSku = insertedSkus.length > 0;
    const [sku] = await db.db
      .select()
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, identity.sku));
    expect(sku).toMatchObject({
      unit: 'second',
      accepts_new_usage: true,
    });
    await db.db.insert(kilocode_users).values(
      users.map((id, index) => ({
        id,
        google_user_email: `admission-${suffix}-${index}@example.test`,
        google_user_name: 'Atomic admission test',
        google_user_image_url: 'https://example.test/avatar.png',
        stripe_customer_id: `cus_admission_${suffix}_${index}`,
        is_bot: index >= 2,
        total_microdollars_acquired: FUNDED_CONTAINER_MINIMUM_MICRODOLLARS - 1,
      }))
    );
    await db.db.insert(organizations).values(
      orgs.map(id => ({
        id,
        name: `Atomic admission ${suffix}`,
        total_microdollars_acquired: FUNDED_CONTAINER_MINIMUM_MICRODOLLARS - 1,
      }))
    );
    await db.db
      .insert(organization_memberships)
      .values(
        orgs.flatMap(organization_id =>
          users.map(kilo_user_id => ({ organization_id, kilo_user_id, role: 'member' as const }))
        )
      );
    const limit =
      race.scope === 'organization' ? ORGANIZATION_CONTAINER_LIMIT : LOW_BALANCE_CONTAINER_LIMIT;
    const seedCount = limit - race.slots;
    const now = Date.now();
    const seedRows = await Promise.all(
      Array.from({ length: seedCount }, async (_, index) => {
        const instanceId = `admission-seed-${suffix}-${index}`;
        seededInstanceIds.push(instanceId);
        const context: UsageContext = {
          service: identity.service,
          instanceId,
          sku: identity.sku,
          subject:
            race.scope === 'organization' || (race.scope === 'cross-org-actor' && index > 0)
              ? organization
              : personal,
          actor: race.scope === 'organization' ? memberActors[2] : actor,
          ...(race.scope === 'organization' ? { onBehalfOf: organization } : {}),
          metadata: { origin: 'cloud-agent' },
        };
        return {
          id: intervalId(context.service, instanceId, now),
          service: context.service,
          instance_id: instanceId,
          start_epoch_ms: now,
          cloud_billing_sku_id: identity.sku,
          context_fingerprint: await usageContextFingerprint(context),
          subject_type: context.subject.type,
          subject_id: context.subject.id,
          actor_type: context.actor.type,
          actor_id: context.actor.id,
          metadata: context.metadata,
          started_at: new Date(now).toISOString(),
          last_seen_at: new Date(now).toISOString(),
        };
      })
    );
    await db.db.insert(container_usage_interval).values(seedRows);
    for (const attempt of attempts) {
      await runInDurableObject(attempt.stub, async (instance, state) => {
        await instance.getAllocationState();
        await state.storage.put('control_plane_owner', attempt.owner);
        if (cloudflareLaunchFailure) {
          const client = createContainerUsageClient(instance.env.CONTAINER_USAGE_METER, {
            service: identity.service,
          });
          const billing = new MeteredBillingLifecycle({
            storage: state.storage,
            usageClient: client,
            isContainerRunning: () => attempt.provider.running.size > 0,
            stopContainer: async () => {},
            destroyContainer: async () => {},
            schedule: async () => {},
            deleteSchedules: () => {},
            getState: async () => ({ status: 'stopped' }),
            durableObjectId: state.id.toString(),
            waitUntil: promise => state.waitUntil(promise),
          });
          billing.attachHeartbeat(
            installBillingHeartbeat(
              {
                getState: async () => ({ status: 'stopped' }),
                schedule: async () => '',
                deleteSchedules: () => {},
              },
              {
                client,
                storage: state.storage,
                beforeStopDelivery: context => billing.ensureStartAcknowledged(context),
              }
            )
          );
          const create = attempt.provider.adapter.create;
          attempt.provider.adapter.create = async intent => {
            await billing.ensureBillingAdmission(
              { sandboxClassName: 'Sandbox' },
              { ...intent.billing, allocationId: intent.intentId }
            );
            return create(intent);
          };
          attempt.provider.adapter.launch = async ref => {
            attempt.provider.launches.push(ref);
            attempt.provider.running.delete(ref);
            throw new Error('Cloudflare launch failed before container start');
          };
          attempt.provider.adapter.releaseBillingAdmission = intent =>
            billing.releaseBillingAdmission(intent.intentId);
        }
        Object.assign(instance, {
          createProviderAdapter: () => attempt.provider.adapter,
          provider: attempt.provider.adapter,
        });
      });
    }

    // AFTER INSERT stalls the real meter transaction before COMMIT, not its RPC response.
    await observer.query(`
      CREATE FUNCTION "${triggerName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}', 0));
        RETURN NEW;
      END $$
    `);
    await observer.query(`
      CREATE TRIGGER "${triggerName}" AFTER INSERT ON container_usage_interval
      FOR EACH ROW WHEN (NEW.instance_id IN (${attemptIds.map(id => `'${id}'`).join(', ')}))
      EXECUTE FUNCTION "${triggerName}"()
    `);
    await gate.query('BEGIN');
    gateHeld = true;
    const gatePid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid;
    const observerPid = (await observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid;
    expect(observerPid).not.toBe(gatePid);
    await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gateKey]);
    await Promise.all(attempts.map(attempt => attempt.stub.ensureAllocation(attempt.input)));
    await waitFor(
      async () => {
        const { rows } = await observer.query<{
          pid: number;
          blockers: number[];
          inserting: boolean;
        }>(`
          SELECT pid, pg_blocking_pids(pid) AS blockers,
            lower(query) LIKE 'insert into "container_usage_interval"%' AS inserting
          FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
        `);
        const inserting = rows.filter(row => row.blockers.includes(gatePid));
        expect(inserting).toHaveLength(1);
        expect(inserting[0].inserting).toBe(true);
        const blocked = new Set([gatePid]);
        for (let depth = 0; depth < ATTEMPTS; depth += 1) {
          for (const row of rows) {
            if (row.blockers.some(pid => blocked.has(pid))) blocked.add(row.pid);
          }
        }
        expect(blocked.size - 1, 'Every competing meter transaction waits for this commit').toBe(
          ATTEMPTS
        );
      },
      { timeout: 1_500, interval: 10 }
    );
    expect((await readAttemptRows()).rows).toEqual([]);
    expect(physicalCounts()).toEqual({ pending: 0, running: 0, creates: 0, launches: 0 });
    expect(
      (await Promise.all(attempts.map(attempt => attempt.stub.getAllocationState()))).map(
        state => state.kind
      )
    ).toEqual(Array.from({ length: ATTEMPTS }, () => 'creating'));
    await gate.query('COMMIT');
    gateHeld = false;

    await waitFor(async () => {
      expect(physicalCounts()).toEqual({
        pending: race.slots,
        running: 0,
        creates: race.slots,
        launches: 0,
      });
      const states = await Promise.all(attempts.map(attempt => attempt.stub.getAllocationState()));
      expect(states.filter(state => state.kind === 'creating')).toHaveLength(race.slots);
      expect(states.filter(state => state.kind === 'stopped')).toHaveLength(ATTEMPTS - race.slots);
    });
    const reserved = (await readAttemptRows()).rows;
    expect(reserved).toHaveLength(race.slots);
    for (const attempt of attempts) {
      if (attempt.provider.creates.length === 0) {
        expect(
          await runInDurableObject(attempt.stub, (_instance, state) =>
            getBillingContext(state.storage)
          )
        ).toBeUndefined();
        continue;
      }
      const create = attempt.provider.creates[0];
      const row = reserved.find(row => row.instance_id === attempt.sandboxId);
      expect(row).toMatchObject({
        status: 'open',
        metadata: { allocation_id: create.intent.intentId },
      });
      expect(create.intent.billing?.allocationId).toBe(create.intent.intentId);
      await attempt.stub.ensureAllocation(attempt.input);
    }
    expect((await readAttemptRows()).rows).toEqual(reserved);
    if (cloudflareLaunchFailure) {
      const winner = attempts.find(attempt => attempt.provider.creates.length > 0);
      if (!winner) throw new Error('Expected admitted Cloudflare allocation');
      await runInDurableObject(winner.stub, async () => {
        winner.provider.creates[0].release();
        await new Promise(resolve => setTimeout(resolve, 25));
      });
      await waitFor(async () => {
        expect(winner.provider.launches).toHaveLength(1);
        expect(winner.provider.pending.size + winner.provider.running.size).toBe(0);
        expect((await readAttemptRows()).rows).toEqual([
          expect.objectContaining({
            status: 'closed',
            confirmed_seconds: 0,
            settled_billable_seconds: 0,
          }),
        ]);
        const checks = await readContainerCapacity(db.db, {
          subject: winner.subject,
          actor: winner.actor,
          instanceId: `observer-${suffix}`,
          checkpoint: 'control-plane-create',
        });
        expect(checks).toContainEqual(expect.objectContaining({ live: 2, limit: 3 }));
      });
      return;
    }
    if (race.outcome !== undefined) {
      const winner = attempts.find(attempt => attempt.provider.creates.length > 0);
      if (!winner) throw new Error('Expected an admitted create');
      const create = winner.provider.creates[0];
      await runInDurableObject(winner.stub, async () => {
        create.fail(
          race.outcome === 'definite-failure'
            ? new ProviderCreationError('invalid_configuration')
            : race.outcome === 'recovered-terminal' || race.outcome === 'ambiguous-timeout'
              ? new AgentSandboxUnavailableError('Provider outcome is unknown', 'sandbox_stopped')
              : new Error('Provider create response timed out; outcome unknown')
        );
        await new Promise(resolve => setTimeout(resolve, 25));
      });
      if (race.outcome === 'definite-failure') {
        await waitFor(async () => {
          expect((await readAttemptRows()).rows).toEqual([
            expect.objectContaining({
              status: 'closed',
              confirmed_seconds: 0,
              settled_billable_seconds: 0,
            }),
          ]);
          expect(
            await runInDurableObject(winner.stub, (_instance, state) =>
              getBillingContext(state.storage)
            )
          ).toBeUndefined();
        });
        const next = attempts.find(attempt => attempt.provider.creates.length === 0);
        if (!next) throw new Error('Expected a previously denied contender');
        await next.stub.ensureAllocation(next.input);
        await waitFor(async () => {
          const rows = (await readAttemptRows()).rows;
          expect(rows.filter(row => row.status === 'open')).toHaveLength(1);
          expect(physicalCounts().pending + physicalCounts().running).toBe(1);
          expect(next.provider.creates).toHaveLength(1);
        });
      } else {
        await waitFor(async () => {
          const state = await winner.stub.getAllocationState();
          expect(state.kind === 'creating' ? state.allocationId : undefined).not.toBe(
            create.intent.intentId
          );
        });
        if (race.outcome === 'ambiguous-failure') {
          await observer.query(
            "UPDATE container_usage_interval SET started_at = started_at - interval '2 minutes', last_seen_at = last_seen_at - interval '2 minutes' WHERE instance_id = $1",
            [winner.sandboxId]
          );
        } else {
          await new Promise(resolve => setTimeout(resolve, 1_100));
          expect((await winner.stub.getAllocationState()).kind).toBe('stopped');
        }
        if (race.outcome === 'ambiguous-timeout') {
          const context = await runInDurableObject(winner.stub, (_instance, state) =>
            getBillingContext(state.storage)
          );
          if (!context) throw new Error('Expected unresolved reservation');
          const elapsed =
            CONTROL_PLANE_TIMERS.sandbox.providerCreateMs + VERCEL_CREATE_SETTLE_MS + 1;
          const startEpochMs = context.startEpochMs - elapsed;
          await observer.query(
            "UPDATE container_usage_interval SET id = $1, start_epoch_ms = $2, started_at = started_at - ($3::double precision * interval '1 millisecond'), last_seen_at = last_seen_at - ($3::double precision * interval '1 millisecond') WHERE instance_id = $4",
            [
              intervalId(context.service, context.instanceId, startEpochMs),
              startEpochMs,
              elapsed,
              winner.sandboxId,
            ]
          );
          await runInDurableObject(winner.stub, (_instance, state) =>
            updateBillingContext(state.storage, {
              ...context,
              startEpochMs,
              usageMeasuredAtMs: startEpochMs,
            })
          );
        }
        await runInDurableObject(winner.stub, async (instance, state) => {
          const context = await getBillingContext(state.storage);
          if (!context) throw new Error('Expected ambiguous reservation to remain');
          if (race.outcome === 'ambiguous-timeout') {
            winner.provider.adapter.observe = async () => {
              throw new Error('Vercel API unavailable');
            };
            await (
              instance as unknown as { billingSchedule: BillingScheduleTable }
            ).billingSchedule.schedule(
              VERCEL_BILLING_SETTLEMENT_CALLBACK,
              Date.now() - 1,
              context.generation
            );
            await instance.alarm();
            return;
          }
          if (race.outcome === 'recovered-terminal') {
            const providerRef = encodeVercelProviderRef({
              sandboxName: winner.sandboxId,
              sessionId: `recovered-${create.intent.intentId}`,
            });
            winner.provider.adapter.observe = async () => {
              await (
                instance as unknown as {
                  recordVercelBillingLifetime: (
                    evidence: VercelBillingLifetimeEvidence
                  ) => Promise<void>;
                }
              ).recordVercelBillingLifetime({
                providerRef,
                allocationId: create.intent.intentId,
                createdAtMs: context.startEpochMs + 50,
                terminalAtMs: Date.now(),
              });
              return { status: 'terminal', providerRef };
            };
          }
          const schedule = await state.storage.get<BillingScheduleEntries>(
            VERCEL_BILLING_SCHEDULE_KEY
          );
          await state.storage.put(VERCEL_BILLING_SCHEDULE_KEY, {
            ...schedule,
            [VERCEL_BILLING_SETTLEMENT_CALLBACK]: {
              dueAtMs: Date.now() - 1,
              payload: context.generation,
            },
          });
          await instance.alarm();
        });
        if (race.outcome === 'ambiguous-timeout') {
          const rows = (await readAttemptRows()).rows;
          expect(rows).toEqual([
            expect.objectContaining({
              status: 'closed',
              confirmed_seconds: 0,
              settled_billable_seconds: 0,
            }),
          ]);
          const checks = await readContainerCapacity(db.db, {
            subject: winner.subject,
            actor: winner.actor,
            instanceId: `observer-${suffix}`,
            checkpoint: 'control-plane-create',
          });
          expect(checks).toContainEqual(expect.objectContaining({ live: 2, limit: 3 }));
          return;
        }
        if (race.outcome === 'recovered-terminal') {
          await waitFor(async () => {
            const rows = (await readAttemptRows()).rows;
            expect(rows).toHaveLength(1);
            expect(rows[0]?.status).toBe('closed');
            expect(rows[0]?.confirmed_seconds).toBeGreaterThan(0);
            expect(
              await runInDurableObject(winner.stub, (_instance, state) =>
                getBillingContext(state.storage)
              )
            ).toBeUndefined();
          });
          return;
        }
        expect((await readAttemptRows()).rows).toEqual(reserved);
        expect(winner.provider.creates).toHaveLength(1);
        const context = await runInDurableObject(winner.stub, (_instance, state) =>
          getBillingContext(state.storage)
        );
        expect(context?.metadata?.allocation_id).toBe(create.intent.intentId);
        expect(context?.pendingStop).toBeUndefined();
        const renewed = await observer.query<{ fresh: boolean }>(
          "SELECT last_seen_at > now() - interval '10 seconds' AS fresh FROM container_usage_interval WHERE instance_id = $1",
          [winner.sandboxId]
        );
        expect(renewed.rows).toEqual([{ fresh: true }]);
        const blocked = attempts.find(attempt => attempt !== winner);
        if (!blocked) throw new Error('Expected another contender');
        const checks = await readContainerCapacity(db.db, {
          subject: blocked.input.billing.subject,
          actor: blocked.input.billing.actor,
          instanceId: blocked.sandboxId,
          checkpoint: 'control-plane-create',
        });
        expect(checks).toContainEqual(expect.objectContaining({ live: 3, limit: 3 }));
      }
      return;
    }
    for (const attempt of attempts.filter(attempt => attempt.provider.creates.length > 0)) {
      await runInDurableObject(attempt.stub, async () => {
        attempt.provider.creates[0].release();
        await new Promise(resolve => setTimeout(resolve, 25));
      });
      const counts = physicalCounts();
      expect(counts.pending + counts.running).toBeLessThanOrEqual(race.slots);
      expect(counts.creates).toBe(race.slots);
    }
    await waitFor(async () => {
      expect(physicalCounts()).toEqual({
        pending: 0,
        running: race.slots,
        creates: race.slots,
        launches: race.slots,
      });
      const states = await Promise.all(attempts.map(attempt => attempt.stub.getAllocationState()));
      expect(states.filter(state => state.kind === 'starting')).toHaveLength(race.slots);
      expect(states.filter(state => state.kind === 'stopped')).toHaveLength(ATTEMPTS - race.slots);
    });
    expect((await readAttemptRows()).rows).toEqual(reserved);
    for (const attempt of attempts) {
      const checks = await readContainerCapacity(db.db, {
        subject: attempt.subject,
        actor: attempt.actor,
        instanceId: 'admission-capacity-observer',
        checkpoint: 'control-plane-create',
      });
      expect(checks.some(check => check.live === check.limit)).toBe(true);
      expect(checks.every(check => check.live <= check.limit)).toBe(true);
    }
  } finally {
    try {
      if (gateHeld) await gate.query('ROLLBACK');
      for (const attempt of attempts) {
        if (attempt.provider.pending.size === 0) continue;
        await runInDurableObject(attempt.stub, async () => {
          for (const create of attempt.provider.creates) create.release();
          await new Promise(resolve => setTimeout(resolve, 25));
        });
      }
      await reset();
      await observer.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON container_usage_interval`);
      await observer.query(`DROP FUNCTION IF EXISTS "${triggerName}"()`);
      await db.db
        .delete(container_usage_interval)
        .where(
          inArray(container_usage_interval.instance_id, [...attemptIds, ...seededInstanceIds])
        );
      await db.db
        .delete(organization_memberships)
        .where(inArray(organization_memberships.organization_id, orgs));
      await db.db.delete(organizations).where(inArray(organizations.id, orgs));
      await db.db.delete(kilocode_users).where(inArray(kilocode_users.id, users));
      if (createdSku)
        await db.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, identity.sku));
    } finally {
      gate.release();
      observer.release();
      await db.pool.end();
    }
  }
}

describe('atomic admission across real SandboxControlV2 Durable Objects and meter RPC', () => {
  it('releases a failed Cloudflare launch with a closed zero-usage interval and no capacity slot', async () => {
    await runRace({ scope: 'personal', slots: 1, outcome: 'cloudflare-launch-failure' });
  });

  it('releases the live reservation after the create deadline and settle window when Vercel observe always throws', async () => {
    await runRace({ scope: 'personal', slots: 1, outcome: 'ambiguous-timeout' });
  });

  it.each([1, 2])(
    'reserves only %i remaining low-balance personal slots while insertion is uncommitted',
    async slots => runRace({ scope: 'personal', slots })
  );

  it('shares the actor cap across personal and two organization payers', async () => {
    await runRace({ scope: 'cross-org-actor', slots: 1 });
  });

  it('shares the organization cap across distinct members and bot actors', async () => {
    await runRace({ scope: 'organization', slots: 1 });
  });

  it('releases a definite failed create without billing and admits a waiting contender', async () => {
    await runRace({ scope: 'personal', slots: 1, outcome: 'definite-failure' });
  });

  it('renews an ambiguous reservation within the create-and-settle window without speculative billing', async () => {
    await runRace({ scope: 'personal', slots: 1, outcome: 'ambiguous-failure' });
  });

  it('settles a recovered terminal provider lifetime instead of voiding its usage', async () => {
    await runRace({ scope: 'personal', slots: 1, outcome: 'recovered-terminal' });
  });
});
