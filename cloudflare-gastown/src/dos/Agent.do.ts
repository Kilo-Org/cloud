/**
 * AgentDO — Per-agent event storage.
 *
 * One instance per agent (keyed by agentId). Owns the high-volume
 * agent_events table, isolating it from the Town DO's 10GB budget.
 * The Town DO writes events here as they flow through; clients query
 * here for backfill when joining a stream late.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  rig_agent_events,
  RigAgentEventRecord,
  createTableRigAgentEvents,
  getIndexesRigAgentEvents,
} from '../db/tables/rig-agent-events.table';
import { query } from '../util/query.util';

const AGENT_DO_LOG = '[Agent.do]';

export class AgentDO extends DurableObject<Env> {
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
    query(this.sql, createTableRigAgentEvents(), []);
    for (const idx of getIndexesRigAgentEvents()) {
      query(this.sql, idx, []);
    }
  }

  /**
   * Append an event. Returns the auto-incremented event ID.
   */
  async appendEvent(eventType: string, data: unknown): Promise<number> {
    await this.ensureInitialized();
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    const timestamp = new Date().toISOString();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${rig_agent_events} (
          ${rig_agent_events.columns.agent_id},
          ${rig_agent_events.columns.event_type},
          ${rig_agent_events.columns.data},
          ${rig_agent_events.columns.created_at}
        ) VALUES (?, ?, ?, ?)
      `,
      [this.ctx.id.name ?? '', eventType, dataStr, timestamp]
    );

    // Return the last inserted rowid
    const rows = [...this.sql.exec('SELECT last_insert_rowid() as id')];
    return Number(rows[0]?.id ?? 0);
  }

  /**
   * Query events for backfill. Returns events with id > afterId, up to limit.
   */
  async getEvents(afterId = 0, limit = 500): Promise<RigAgentEventRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${rig_agent_events}
          WHERE ${rig_agent_events.columns.id} > ?
          ORDER BY ${rig_agent_events.columns.id} ASC
          LIMIT ?
        `,
        [afterId, limit]
      ),
    ];
    return RigAgentEventRecord.array().parse(rows);
  }

  /**
   * Delete all events. Called when the agent is deleted from the Town DO.
   */
  async destroy(): Promise<void> {
    console.log(`${AGENT_DO_LOG} destroy: clearing all storage`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async ping(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

export function getAgentDOStub(env: Env, agentId: string) {
  return env.AGENT.get(env.AGENT.idFromName(agentId));
}
