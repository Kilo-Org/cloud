import { DurableObject } from 'cloudflare:workers';
import {
  town_convoys,
  TownConvoyRecord,
  createTableTownConvoys,
} from '../db/tables/town-convoys.table';
import {
  town_convoy_beads,
  createTableTownConvoyBeads,
} from '../db/tables/town-convoy-beads.table';
import {
  createTableTownEscalations,
  town_escalations,
  TownEscalationRecord,
} from '../db/tables/town-escalations.table';
import { query } from '../util/query.util';
import { getTownContainerStub } from './TownContainer.do';
import { getMayorDOStub } from './Mayor.do';
import { z } from 'zod';
import { TownConfigSchema, type TownConfig, type TownConfigUpdate } from '../types';

const TOWN_LOG = '[Town.do]';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

const HEARTBEAT_ALARM_INTERVAL_MS = 3 * 60 * 1000;

// Auto-re-escalation: unacknowledged escalations older than this threshold
// get their severity bumped (default 4 hours)
const STALE_ESCALATION_THRESHOLD_MS = 4 * 60 * 60 * 1000;
const MAX_RE_ESCALATIONS = 3;
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'] as const;

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
    query(this.sql, createTableTownConvoys(), []);
    query(this.sql, createTableTownConvoyBeads(), []);
    query(this.sql, createTableTownEscalations(), []);

    // Composite primary keys are not supported by getCreateTableQueryFromTable.
    // Enforce uniqueness via a unique index.
    query(
      this.sql,
      /* sql */ `CREATE UNIQUE INDEX IF NOT EXISTS idx_town_convoy_beads_pk ON ${town_convoy_beads}(${town_convoy_beads.columns.convoy_id}, ${town_convoy_beads.columns.bead_id})`,
      []
    );
  }

  // ── Town Configuration ─────────────────────────────────────────────────

  private static readonly CONFIG_KEY = 'town:config';

  async getTownConfig(): Promise<TownConfig> {
    const raw = await this.ctx.storage.get<unknown>(TownDO.CONFIG_KEY);
    if (!raw) return TownConfigSchema.parse({});
    return TownConfigSchema.parse(raw);
  }

  async updateTownConfig(update: TownConfigUpdate): Promise<TownConfig> {
    const current = await this.getTownConfig();

    // env_vars: full replacement semantics so the UI can delete variables by
    // omitting them. However, masked values (starting with "****") from the
    // server's masking layer must be preserved — replace them with the
    // current stored value to avoid overwriting secrets with masked placeholders.
    let resolvedEnvVars = current.env_vars;
    if (update.env_vars) {
      resolvedEnvVars = {};
      for (const [key, value] of Object.entries(update.env_vars)) {
        resolvedEnvVars[key] = value.startsWith('****') ? (current.env_vars[key] ?? value) : value;
      }
    }

    const merged: TownConfig = {
      ...current,
      ...update,
      env_vars: resolvedEnvVars,
      git_auth: { ...current.git_auth, ...(update.git_auth ?? {}) },
      refinery:
        update.refinery !== undefined
          ? { ...current.refinery, ...update.refinery }
          : current.refinery,
      container:
        update.container !== undefined
          ? { ...current.container, ...update.container }
          : current.container,
    };

    const validated = TownConfigSchema.parse(merged);
    await this.ctx.storage.put(TownDO.CONFIG_KEY, validated);
    console.log(
      `${TOWN_LOG} updateTownConfig: saved config with ${Object.keys(validated.env_vars).length} env vars`
    );
    return validated;
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
    delete next[parsed.rigId];
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
  }): Promise<TownConvoyRecord> {
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
        INSERT INTO ${town_convoys} (
          ${town_convoys.columns.id},
          ${town_convoys.columns.title},
          ${town_convoys.columns.status},
          ${town_convoys.columns.total_beads},
          ${town_convoys.columns.closed_beads},
          ${town_convoys.columns.created_by},
          ${town_convoys.columns.created_at},
          ${town_convoys.columns.landed_at}
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
          INSERT INTO ${town_convoy_beads} (
            ${town_convoy_beads.columns.convoy_id},
            ${town_convoy_beads.columns.bead_id},
            ${town_convoy_beads.columns.rig_id},
            ${town_convoy_beads.columns.status}
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

  async onBeadClosed(input: {
    convoyId: string;
    beadId: string;
  }): Promise<TownConvoyRecord | null> {
    await this.ensureInitialized();
    const parsed = z
      .object({ convoyId: z.string().min(1), beadId: z.string().min(1) })
      .parse(input);

    // Mark bead closed in convoy_beads.
    query(
      this.sql,
      /* sql */ `
        UPDATE ${town_convoy_beads}
        SET ${town_convoy_beads.columns.status} = ?
        WHERE ${town_convoy_beads.columns.convoy_id} = ?
          AND ${town_convoy_beads.columns.bead_id} = ?
          AND ${town_convoy_beads.columns.status} != ?
      `,
      ['closed', parsed.convoyId, parsed.beadId, 'closed']
    );

    // Recompute closed count from convoy_beads for correctness.
    const closedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(1) AS count
          FROM ${town_convoy_beads}
          WHERE ${town_convoy_beads.columns.convoy_id} = ?
            AND ${town_convoy_beads.columns.status} = ?
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
        UPDATE ${town_convoys}
        SET ${town_convoys.columns.closed_beads} = ?
        WHERE ${town_convoys.columns.id} = ?
      `,
      [closedCount, parsed.convoyId]
    );

    const convoy = this.getConvoy(parsed.convoyId);
    if (!convoy) return null;

    if (convoy.status === 'active' && convoy.closed_beads >= convoy.total_beads) {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${town_convoys}
          SET ${town_convoys.columns.status} = ?,
              ${town_convoys.columns.landed_at} = ?
          WHERE ${town_convoys.columns.id} = ?
        `,
        ['landed', now(), parsed.convoyId]
      );
    }

    return this.getConvoy(parsed.convoyId);
  }

  private getConvoy(convoyId: string): TownConvoyRecord | null {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${town_convoys} WHERE ${town_convoys.columns.id} = ?`,
        [convoyId]
      ),
    ];
    if (rows.length === 0) return null;
    return TownConvoyRecord.parse(rows[0]);
  }

  // ── Escalations ───────────────────────────────────────────────────────

  async acknowledgeEscalation(escalationId: string): Promise<TownEscalationRecord | null> {
    await this.ensureInitialized();
    const parsed = z.string().min(1).parse(escalationId);

    query(
      this.sql,
      /* sql */ `
        UPDATE ${town_escalations}
        SET ${town_escalations.columns.acknowledged} = 1,
            ${town_escalations.columns.acknowledged_at} = ?
        WHERE ${town_escalations.columns.id} = ?
          AND ${town_escalations.columns.acknowledged} = 0
      `,
      [now(), parsed]
    );

    return this.getEscalation(parsed);
  }

  async listEscalations(filter?: { acknowledged?: boolean }): Promise<TownEscalationRecord[]> {
    await this.ensureInitialized();

    const rows =
      filter?.acknowledged !== undefined
        ? [
            ...query(
              this.sql,
              /* sql */ `
              SELECT * FROM ${town_escalations}
              WHERE ${town_escalations.columns.acknowledged} = ?
              ORDER BY ${town_escalations.columns.created_at} DESC
              LIMIT 100
            `,
              [filter.acknowledged ? 1 : 0]
            ),
          ]
        : [
            ...query(
              this.sql,
              /* sql */ `
              SELECT * FROM ${town_escalations}
              ORDER BY ${town_escalations.columns.created_at} DESC
              LIMIT 100
            `,
              []
            ),
          ];

    return TownEscalationRecord.array().parse(rows);
  }

  async routeEscalation(input: {
    townId: string;
    source_rig_id: string;
    source_agent_id?: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    category?: string;
    message: string;
  }): Promise<TownEscalationRecord> {
    await this.ensureInitialized();
    const parsed = z
      .object({
        townId: z.string().min(1),
        source_rig_id: z.string().min(1),
        source_agent_id: z.string().min(1).optional(),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        category: z.string().min(1).optional(),
        message: z.string().min(1),
      })
      .parse(input);

    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${town_escalations} (
          ${town_escalations.columns.id},
          ${town_escalations.columns.source_rig_id},
          ${town_escalations.columns.source_agent_id},
          ${town_escalations.columns.severity},
          ${town_escalations.columns.category},
          ${town_escalations.columns.message},
          ${town_escalations.columns.acknowledged},
          ${town_escalations.columns.re_escalation_count},
          ${town_escalations.columns.created_at},
          ${town_escalations.columns.acknowledged_at}
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

  private getEscalation(escalationId: string): TownEscalationRecord | null {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${town_escalations} WHERE ${town_escalations.columns.id} = ?`,
        [escalationId]
      ),
    ];
    if (rows.length === 0) return null;
    return TownEscalationRecord.parse(rows[0]);
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

    // Auto-re-escalation: bump severity of stale unacknowledged escalations
    try {
      await this.reEscalateStaleEscalations(townId);
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: reEscalateStaleEscalations failed`, err);
    }

    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_ALARM_INTERVAL_MS);
  }

  /**
   * Find unacknowledged escalations older than the stale threshold
   * and bump their severity by one level.
   */
  private async reEscalateStaleEscalations(townId: string): Promise<void> {
    await this.ensureInitialized();
    const threshold = new Date(Date.now() - STALE_ESCALATION_THRESHOLD_MS).toISOString();

    const candidateRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${town_escalations}
          WHERE ${town_escalations.columns.acknowledged} = 0
            AND ${town_escalations.columns.re_escalation_count} < ?
        `,
        [MAX_RE_ESCALATIONS]
      ),
    ];

    const candidates = TownEscalationRecord.array().parse(candidateRows);

    // Filter to escalations old enough for their NEXT re-escalation.
    // Each bump requires an additional STALE_ESCALATION_THRESHOLD_MS interval,
    // so bump N requires (N+1) * threshold age. This prevents all 3 bumps
    // from firing within minutes once the first threshold is crossed.
    const nowMs = Date.now();
    const stale = candidates.filter(esc => {
      const ageMs = nowMs - new Date(esc.created_at).getTime();
      const requiredAgeMs = (esc.re_escalation_count + 1) * STALE_ESCALATION_THRESHOLD_MS;
      return ageMs >= requiredAgeMs;
    });
    if (stale.length === 0) return;

    for (const esc of stale) {
      const currentIdx = SEVERITY_ORDER.indexOf(esc.severity as (typeof SEVERITY_ORDER)[number]);
      if (currentIdx < 0 || currentIdx >= SEVERITY_ORDER.length - 1) continue;

      const newSeverity = SEVERITY_ORDER[currentIdx + 1];
      query(
        this.sql,
        /* sql */ `
          UPDATE ${town_escalations}
          SET ${town_escalations.columns.severity} = ?,
              ${town_escalations.columns.re_escalation_count} = ${town_escalations.columns.re_escalation_count} + 1
          WHERE ${town_escalations.columns.id} = ?
        `,
        [newSeverity, esc.id]
      );

      console.log(
        `${TOWN_LOG} reEscalateStaleEscalations: escalation ${esc.id} bumped from ${esc.severity} to ${newSeverity} (re-escalation #${esc.re_escalation_count + 1})`
      );

      // Notify mayor for medium+ escalations
      if (newSeverity !== 'low') {
        try {
          const mayor = getMayorDOStub(this.env, townId);
          await mayor.sendMessage(
            `[Re-Escalation:${newSeverity}] rig=${esc.source_rig_id} ${esc.message} (auto-bumped from ${esc.severity} after ${STALE_ESCALATION_THRESHOLD_MS / 3600000}h unacknowledged)`
          );
        } catch (err) {
          console.warn(`${TOWN_LOG} reEscalateStaleEscalations: failed to notify mayor:`, err);
        }
      }
    }
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
