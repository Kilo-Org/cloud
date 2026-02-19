import { DurableObject } from 'cloudflare:workers';
import {
  convoys,
  ConvoyRecord,
  ConvoyStatus,
  createTableConvoys,
} from '../db/tables/convoys.table';
import {
  convoyBeads,
  ConvoyBeadStatus,
  createTableConvoyBeads,
} from '../db/tables/convoy-beads.table';
import {
  createTableEscalations,
  escalations,
  EscalationRecord,
} from '../db/tables/escalations.table';
import { query } from '../util/query.util';
import { getTownContainerStub } from './TownContainer.do';
import { getMayorDOStub } from './Mayor.do';
import { z } from 'zod';

const TOWN_LOG = '[Town.do]';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

const HEARTBEAT_ALARM_INTERVAL_MS = 3 * 60 * 1000;

export class TownDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private initPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      await this.ensureInitialized();
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }
    await this.initPromise;
  }

  private async initializeDatabase(): Promise<void> {
    query(this.sql, createTableConvoys(), []);
    query(this.sql, createTableConvoyBeads(), []);
    query(this.sql, createTableEscalations(), []);

    // Composite primary keys are not supported by getCreateTableQueryFromTable.
    // Enforce uniqueness via a unique index.
    query(
      this.sql,
      /* sql */ `CREATE UNIQUE INDEX IF NOT EXISTS idx_convoy_beads_pk ON ${convoyBeads}(${convoyBeads.columns.convoy_id}, ${convoyBeads.columns.bead_id})`,
      []
    );
  }

  // ── Rig Registry (KV for now) ─────────────────────────────────────────

  private static rigsKey(townId: string): string {
    return `town:${townId}:rigs`;
  }

  async addRig(input: {
    townId: string;
    rigId: string;
    name: string;
    rig_do_id: string;
  }): Promise<void> {
    const parsed = z
      .object({
        townId: z.string().min(1),
        rigId: z.string().min(1),
        name: z.string().min(1),
        rig_do_id: z.string().min(1),
      })
      .parse(input);

    const key = TownDO.rigsKey(parsed.townId);
    const existing = (await this.ctx.storage.get<Record<string, unknown>>(key)) ?? {};
    const next = {
      ...existing,
      [parsed.rigId]: { id: parsed.rigId, name: parsed.name, rig_do_id: parsed.rig_do_id },
    };
    await this.ctx.storage.put(key, next);
  }

  async removeRig(input: { townId: string; rigId: string }): Promise<void> {
    const parsed = z.object({ townId: z.string().min(1), rigId: z.string().min(1) }).parse(input);
    const key = TownDO.rigsKey(parsed.townId);
    const existing = (await this.ctx.storage.get<Record<string, unknown>>(key)) ?? {};
    if (!(parsed.rigId in existing)) return;
    const next = { ...existing };
    delete (next as Record<string, unknown>)[parsed.rigId];
    await this.ctx.storage.put(key, next);
  }

  async listRigs(input: {
    townId: string;
  }): Promise<Array<{ id: string; name: string; rig_do_id: string }>> {
    const parsed = z.object({ townId: z.string().min(1) }).parse(input);
    const key = TownDO.rigsKey(parsed.townId);
    const existing = (await this.ctx.storage.get<Record<string, unknown>>(key)) ?? {};
    const Rig = z.object({ id: z.string(), name: z.string(), rig_do_id: z.string() });
    const record = z.record(z.string(), Rig).parse(existing);
    return Object.values(record);
  }

  // ── Convoys ───────────────────────────────────────────────────────────

  async createConvoy(input: {
    title: string;
    beads: Array<{ bead_id: string; rig_id: string }>;
    created_by?: string;
  }): Promise<ConvoyRecord> {
    await this.ensureInitialized();
    const parsed = z
      .object({
        title: z.string().min(1),
        beads: z.array(z.object({ bead_id: z.string().min(1), rig_id: z.string().min(1) })).min(1),
        created_by: z.string().min(1).optional(),
      })
      .parse(input);

    const convoyId = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${convoys} (
          ${convoys.columns.id},
          ${convoys.columns.title},
          ${convoys.columns.status},
          ${convoys.columns.total_beads},
          ${convoys.columns.closed_beads},
          ${convoys.columns.created_by},
          ${convoys.columns.created_at},
          ${convoys.columns.landed_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        convoyId,
        parsed.title,
        'active',
        parsed.beads.length,
        0,
        parsed.created_by ?? null,
        timestamp,
        null,
      ]
    );

    for (const bead of parsed.beads) {
      query(
        this.sql,
        /* sql */ `
          INSERT INTO ${convoyBeads} (
            ${convoyBeads.columns.convoy_id},
            ${convoyBeads.columns.bead_id},
            ${convoyBeads.columns.rig_id},
            ${convoyBeads.columns.status}
          ) VALUES (?, ?, ?, ?)
        `,
        [convoyId, bead.bead_id, bead.rig_id, 'open']
      );
    }

    const convoy = this.getConvoy(convoyId);
    if (!convoy) throw new Error('Failed to create convoy');
    console.log(
      `${TOWN_LOG} createConvoy: id=${convoyId} title=${parsed.title} beads=${parsed.beads.length}`
    );
    await this.armAlarm();
    return convoy;
  }

  async onBeadClosed(input: { convoyId: string; beadId: string }): Promise<ConvoyRecord | null> {
    await this.ensureInitialized();
    const parsed = z
      .object({ convoyId: z.string().min(1), beadId: z.string().min(1) })
      .parse(input);

    // Mark bead closed in convoy_beads.
    query(
      this.sql,
      /* sql */ `
        UPDATE ${convoyBeads}
        SET ${convoyBeads.columns.status} = ?
        WHERE ${convoyBeads.columns.convoy_id} = ?
          AND ${convoyBeads.columns.bead_id} = ?
          AND ${convoyBeads.columns.status} != ?
      `,
      ['closed', parsed.convoyId, parsed.beadId, 'closed']
    );

    // Recompute closed count from convoy_beads for correctness.
    const closedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(1) AS count
          FROM ${convoyBeads}
          WHERE ${convoyBeads.columns.convoy_id} = ?
            AND ${convoyBeads.columns.status} = ?
        `,
        [parsed.convoyId, 'closed']
      ),
    ];
    const closedCount = z
      .object({ count: z.number() })
      .transform(v => v.count)
      .parse(closedRows[0] ?? { count: 0 });

    query(
      this.sql,
      /* sql */ `
        UPDATE ${convoys}
        SET ${convoys.columns.closed_beads} = ?
        WHERE ${convoys.columns.id} = ?
      `,
      [closedCount, parsed.convoyId]
    );

    const convoy = this.getConvoy(parsed.convoyId);
    if (!convoy) return null;

    if (convoy.status === 'active' && convoy.closed_beads >= convoy.total_beads) {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${convoys}
          SET ${convoys.columns.status} = ?,
              ${convoys.columns.landed_at} = ?
          WHERE ${convoys.columns.id} = ?
        `,
        ['landed', now(), parsed.convoyId]
      );
    }

    return this.getConvoy(parsed.convoyId);
  }

  private getConvoy(convoyId: string): ConvoyRecord | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${convoys} WHERE ${convoys.columns.id} = ?`, [
        convoyId,
      ]),
    ];
    if (rows.length === 0) return null;
    return ConvoyRecord.parse(rows[0]);
  }

  // ── Escalations ───────────────────────────────────────────────────────

  async routeEscalation(input: {
    townId: string;
    source_rig_id: string;
    source_agent_id?: string;
    severity: 'low' | 'medium' | 'high';
    category?: string;
    message: string;
  }): Promise<EscalationRecord> {
    await this.ensureInitialized();
    const parsed = z
      .object({
        townId: z.string().min(1),
        source_rig_id: z.string().min(1),
        source_agent_id: z.string().min(1).optional(),
        severity: z.enum(['low', 'medium', 'high']),
        category: z.string().min(1).optional(),
        message: z.string().min(1),
      })
      .parse(input);

    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${escalations} (
          ${escalations.columns.id},
          ${escalations.columns.source_rig_id},
          ${escalations.columns.source_agent_id},
          ${escalations.columns.severity},
          ${escalations.columns.category},
          ${escalations.columns.message},
          ${escalations.columns.acknowledged},
          ${escalations.columns.re_escalation_count},
          ${escalations.columns.created_at},
          ${escalations.columns.acknowledged_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        parsed.source_rig_id,
        parsed.source_agent_id ?? null,
        parsed.severity,
        parsed.category ?? null,
        parsed.message,
        0,
        0,
        timestamp,
        null,
      ]
    );

    const escalation = this.getEscalation(id);
    if (!escalation) throw new Error('Failed to create escalation');

    // Route: low -> log only, medium/high -> notify Mayor.
    if (parsed.severity !== 'low') {
      try {
        const mayor = getMayorDOStub(this.env, parsed.townId);
        // Placeholder "notify" by sending message into Mayor session.
        // If the Mayor isn't configured yet, this will throw and we log.
        await mayor.sendMessage(
          `[Escalation:${parsed.severity}] rig=${parsed.source_rig_id} ${parsed.message}`
        );
      } catch (err) {
        console.warn(`${TOWN_LOG} routeEscalation: failed to notify mayor:`, err);
      }
    }

    return escalation;
  }

  private getEscalation(escalationId: string): EscalationRecord | null {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${escalations} WHERE ${escalations.columns.id} = ?`,
        [escalationId]
      ),
    ];
    if (rows.length === 0) return null;
    return EscalationRecord.parse(rows[0]);
  }

  // ── Watchdog heartbeat alarm ───────────────────────────────────────────

  async watchdogHeartbeat(townId: string): Promise<{ container_ok: boolean }> {
    const parsed = z.object({ townId: z.string().min(1) }).parse({ townId });
    let ok = false;
    try {
      const container = getTownContainerStub(this.env, parsed.townId);
      const res = await container.fetch('http://container/health');
      ok = res.ok;
    } catch {
      ok = false;
    }
    return { container_ok: ok };
  }

  async alarm(): Promise<void> {
    // Best-effort heartbeat. This DO is keyed by townId name.
    const townId = this.ctx.id.name;
    if (!townId) {
      console.warn(`${TOWN_LOG} alarm: missing ctx.id.name; skipping watchdog`);
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_ALARM_INTERVAL_MS);
      return;
    }
    console.log(`${TOWN_LOG} alarm: fired for town name=${townId}`);
    try {
      await this.watchdogHeartbeat(townId);
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: watchdogHeartbeat failed`, err);
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_ALARM_INTERVAL_MS);
  }

  private async armAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (!current || current < Date.now()) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_ALARM_INTERVAL_MS);
    }
  }
}

export function getTownDOStub(env: Env, townId: string) {
  return env.TOWN.get(env.TOWN.idFromName(townId));
}
