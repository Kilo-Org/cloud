import { DurableObject } from 'cloudflare:workers';
import { createTableBeads, getIndexesBeads, beads, BeadRecord } from '../db/tables/beads.table';
import { createTableAgents, agents, AgentRecord } from '../db/tables/agents.table';
import { createTableMail, getIndexesMail, mail, MailRecord } from '../db/tables/mail.table';
import {
  createTableReviewQueue,
  reviewQueue,
  ReviewQueueRecord,
} from '../db/tables/review-queue.table';
import { createTableMolecules } from '../db/tables/molecules.table';
import { getTownContainerStub } from './TownContainer.do';
import { query } from '../util/query.util';
import type {
  Bead,
  BeadStatus,
  CreateBeadInput,
  BeadFilter,
  Agent,
  AgentStatus,
  RegisterAgentInput,
  AgentFilter,
  Mail,
  SendMailInput,
  ReviewQueueEntry,
  ReviewQueueInput,
  PrimeContext,
  AgentDoneInput,
  PatrolResult,
} from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// Stale threshold: agents with no activity for 10 minutes
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

// GUPP violation threshold: 30 minutes with no progress
const GUPP_THRESHOLD_MS = 30 * 60 * 1000;

// Alarm intervals
const ACTIVE_ALARM_INTERVAL_MS = 30_000; // 30s when there's active work
const IDLE_ALARM_INTERVAL_MS = 300_000; // 5 min when idle

// KV key for storing the town ID associated with this rig
const TOWN_ID_KEY = 'townId';

export class RigDO extends DurableObject<Env> {
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
    // Tables must be created in dependency order (beads first, then agents, etc.)
    query(this.sql, createTableBeads(), []);
    for (const idx of getIndexesBeads()) {
      query(this.sql, idx, []);
    }

    query(this.sql, createTableAgents(), []);
    query(this.sql, createTableMail(), []);
    for (const idx of getIndexesMail()) {
      query(this.sql, idx, []);
    }

    query(this.sql, createTableReviewQueue(), []);
    query(this.sql, createTableMolecules(), []);
  }

  // ── Beads ──────────────────────────────────────────────────────────────

  async createBead(input: CreateBeadInput): Promise<Bead> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();
    const labelsJson = JSON.stringify(input.labels ?? []);
    const metadataJson = JSON.stringify(input.metadata ?? {});

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${beads} (
          ${beads.columns.id},
          ${beads.columns.type},
          ${beads.columns.status},
          ${beads.columns.title},
          ${beads.columns.body},
          ${beads.columns.assignee_agent_id},
          ${beads.columns.convoy_id},
          ${beads.columns.priority},
          ${beads.columns.labels},
          ${beads.columns.metadata},
          ${beads.columns.created_at},
          ${beads.columns.updated_at}
        ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.type,
        input.title,
        input.body ?? null,
        input.assignee_agent_id ?? null,
        input.convoy_id ?? null,
        input.priority ?? 'medium',
        labelsJson,
        metadataJson,
        timestamp,
        timestamp,
      ]
    );

    const result = this.getBead(id);
    if (!result) throw new Error('Failed to create bead');
    return result;
  }

  async getBeadAsync(beadId: string): Promise<Bead | null> {
    await this.ensureInitialized();
    return this.getBead(beadId);
  }

  private getBead(beadId: string): Bead | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${beads} WHERE ${beads.columns.id} = ?`, [
        beadId,
      ]),
    ];
    if (rows.length === 0) return null;
    return BeadRecord.parse(rows[0]);
  }

  async listBeads(filter: BeadFilter): Promise<Bead[]> {
    await this.ensureInitialized();

    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${beads}
          WHERE (? IS NULL OR ${beads.columns.status} = ?)
            AND (? IS NULL OR ${beads.columns.type} = ?)
            AND (? IS NULL OR ${beads.columns.assignee_agent_id} = ?)
            AND (? IS NULL OR ${beads.columns.convoy_id} = ?)
          ORDER BY ${beads.columns.created_at} DESC
          LIMIT ? OFFSET ?
        `,
        [
          filter.status ?? null,
          filter.status ?? null,
          filter.type ?? null,
          filter.type ?? null,
          filter.assignee_agent_id ?? null,
          filter.assignee_agent_id ?? null,
          filter.convoy_id ?? null,
          filter.convoy_id ?? null,
          filter.limit ?? 100,
          filter.offset ?? 0,
        ]
      ),
    ];
    return BeadRecord.array().parse(rows);
  }

  async updateBeadStatus(beadId: string, status: BeadStatus, agentId: string): Promise<Bead> {
    await this.ensureInitialized();
    const timestamp = now();
    const closedAt = status === 'closed' ? timestamp : null;

    query(
      this.sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.status} = ?,
            ${beads.columns.updated_at} = ?,
            ${beads.columns.closed_at} = COALESCE(?, ${beads.columns.closed_at})
        WHERE ${beads.columns.id} = ?
      `,
      [status, timestamp, closedAt, beadId]
    );

    this.touchAgent(agentId);

    const bead = this.getBead(beadId);
    if (!bead) throw new Error(`Bead ${beadId} not found`);
    return bead;
  }

  async closeBead(beadId: string, agentId: string): Promise<Bead> {
    return this.updateBeadStatus(beadId, 'closed', agentId);
  }

  // ── Agents ─────────────────────────────────────────────────────────────

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${agents} (
          ${agents.columns.id},
          ${agents.columns.role},
          ${agents.columns.name},
          ${agents.columns.identity},
          ${agents.columns.status},
          ${agents.columns.created_at},
          ${agents.columns.last_activity_at}
        ) VALUES (?, ?, ?, ?, 'idle', ?, ?)
      `,
      [id, input.role, input.name, input.identity, timestamp, timestamp]
    );

    const agent = this.getAgent(id);
    if (!agent) throw new Error('Failed to register agent');
    return agent;
  }

  async getAgentAsync(agentId: string): Promise<Agent | null> {
    await this.ensureInitialized();
    return this.getAgent(agentId);
  }

  private getAgent(agentId: string): Agent | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${agents} WHERE ${agents.columns.id} = ?`, [
        agentId,
      ]),
    ];
    if (rows.length === 0) return null;
    return AgentRecord.parse(rows[0]);
  }

  async getAgentByIdentity(identity: string): Promise<Agent | null> {
    await this.ensureInitialized();
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${agents} WHERE ${agents.columns.identity} = ?`, [
        identity,
      ]),
    ];
    if (rows.length === 0) return null;
    return AgentRecord.parse(rows[0]);
  }

  async listAgents(filter?: AgentFilter): Promise<Agent[]> {
    await this.ensureInitialized();

    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${agents}
          WHERE (? IS NULL OR ${agents.columns.role} = ?)
            AND (? IS NULL OR ${agents.columns.status} = ?)
        `,
        [filter?.role ?? null, filter?.role ?? null, filter?.status ?? null, filter?.status ?? null]
      ),
    ];
    return AgentRecord.array().parse(rows);
  }

  async updateAgentSession(agentId: string, sessionId: string | null): Promise<void> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agents}
        SET ${agents.columns.cloud_agent_session_id} = ?,
            ${agents.columns.last_activity_at} = ?
        WHERE ${agents.columns.id} = ?
      `,
      [sessionId, now(), agentId]
    );
  }

  async updateAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agents}
        SET ${agents.columns.status} = ?,
            ${agents.columns.last_activity_at} = ?
        WHERE ${agents.columns.id} = ?
      `,
      [status, now(), agentId]
    );
  }

  // ── Hooks (GUPP) ──────────────────────────────────────────────────────

  async hookBead(agentId: string, beadId: string): Promise<void> {
    await this.ensureInitialized();

    // Verify bead exists
    const bead = this.getBead(beadId);
    if (!bead) throw new Error(`Bead ${beadId} not found`);

    // Verify agent exists
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Check agent isn't already hooked to another bead
    if (agent.current_hook_bead_id && agent.current_hook_bead_id !== beadId) {
      throw new Error(`Agent ${agentId} is already hooked to bead ${agent.current_hook_bead_id}`);
    }

    query(
      this.sql,
      /* sql */ `
        UPDATE ${agents}
        SET ${agents.columns.current_hook_bead_id} = ?,
            ${agents.columns.status} = 'working',
            ${agents.columns.last_activity_at} = ?
        WHERE ${agents.columns.id} = ?
      `,
      [beadId, now(), agentId]
    );

    query(
      this.sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.status} = 'in_progress',
            ${beads.columns.assignee_agent_id} = ?,
            ${beads.columns.updated_at} = ?
        WHERE ${beads.columns.id} = ?
      `,
      [agentId, now(), beadId]
    );

    await this.armAlarmIfNeeded();
  }

  async unhookBead(agentId: string): Promise<void> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agents}
        SET ${agents.columns.current_hook_bead_id} = NULL,
            ${agents.columns.cloud_agent_session_id} = NULL,
            ${agents.columns.status} = 'idle',
            ${agents.columns.last_activity_at} = ?
        WHERE ${agents.columns.id} = ?
      `,
      [now(), agentId]
    );
  }

  async getHookedBead(agentId: string): Promise<Bead | null> {
    await this.ensureInitialized();
    const agent = this.getAgent(agentId);
    if (!agent?.current_hook_bead_id) return null;
    return this.getBead(agent.current_hook_bead_id);
  }

  // ── Mail ───────────────────────────────────────────────────────────────

  async sendMail(input: SendMailInput): Promise<void> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${mail} (
          ${mail.columns.id},
          ${mail.columns.from_agent_id},
          ${mail.columns.to_agent_id},
          ${mail.columns.subject},
          ${mail.columns.body},
          ${mail.columns.created_at}
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [id, input.from_agent_id, input.to_agent_id, input.subject, input.body, timestamp]
    );
  }

  async checkMail(agentId: string): Promise<Mail[]> {
    await this.ensureInitialized();
    const timestamp = now();

    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${mail}
          WHERE ${mail.columns.to_agent_id} = ?
            AND ${mail.columns.delivered} = 0
          ORDER BY ${mail.columns.created_at} ASC
        `,
        [agentId]
      ),
    ];

    // Mark as delivered
    if (rows.length > 0) {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${mail}
          SET ${mail.columns.delivered} = 1,
              ${mail.columns.delivered_at} = ?
          WHERE ${mail.columns.to_agent_id} = ?
            AND ${mail.columns.delivered} = 0
        `,
        [timestamp, agentId]
      );
    }

    this.touchAgent(agentId);
    return MailRecord.array().parse(rows);
  }

  // ── Review Queue ───────────────────────────────────────────────────────

  async submitToReviewQueue(input: ReviewQueueInput): Promise<void> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${reviewQueue} (
          ${reviewQueue.columns.id},
          ${reviewQueue.columns.agent_id},
          ${reviewQueue.columns.bead_id},
          ${reviewQueue.columns.branch},
          ${reviewQueue.columns.pr_url},
          ${reviewQueue.columns.summary},
          ${reviewQueue.columns.created_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.agent_id,
        input.bead_id,
        input.branch,
        input.pr_url ?? null,
        input.summary ?? null,
        timestamp,
      ]
    );
  }

  async popReviewQueue(): Promise<ReviewQueueEntry | null> {
    await this.ensureInitialized();

    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${reviewQueue}
          WHERE ${reviewQueue.columns.status} = 'pending'
          ORDER BY ${reviewQueue.columns.created_at} ASC
          LIMIT 1
        `,
        []
      ),
    ];
    if (rows.length === 0) return null;

    const entry = ReviewQueueRecord.parse(rows[0]);

    query(
      this.sql,
      /* sql */ `
        UPDATE ${reviewQueue}
        SET ${reviewQueue.columns.status} = 'running',
            ${reviewQueue.columns.processed_at} = ?
        WHERE ${reviewQueue.columns.id} = ?
      `,
      [now(), entry.id]
    );

    return { ...entry, status: 'running' };
  }

  async completeReview(entryId: string, status: 'merged' | 'failed'): Promise<void> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${reviewQueue}
        SET ${reviewQueue.columns.status} = ?,
            ${reviewQueue.columns.processed_at} = ?
        WHERE ${reviewQueue.columns.id} = ?
      `,
      [status, now(), entryId]
    );
  }

  // ── Prime (context assembly) ───────────────────────────────────────────

  async prime(agentId: string): Promise<PrimeContext> {
    await this.ensureInitialized();

    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const hooked_bead = agent.current_hook_bead_id
      ? this.getBead(agent.current_hook_bead_id)
      : null;

    const undeliveredRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${mail}
          WHERE ${mail.columns.to_agent_id} = ?
            AND ${mail.columns.delivered} = 0
          ORDER BY ${mail.columns.created_at} ASC
        `,
        [agentId]
      ),
    ];

    const openBeadRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${beads}
          WHERE ${beads.columns.assignee_agent_id} = ?
            AND ${beads.columns.status} != 'closed'
          ORDER BY ${beads.columns.created_at} DESC
        `,
        [agentId]
      ),
    ];

    this.touchAgent(agentId);

    return {
      agent,
      hooked_bead,
      undelivered_mail: MailRecord.array().parse(undeliveredRows),
      open_beads: BeadRecord.array().parse(openBeadRows),
    };
  }

  // ── Checkpoint ─────────────────────────────────────────────────────────

  async writeCheckpoint(agentId: string, data: unknown): Promise<void> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agents}
        SET ${agents.columns.checkpoint} = ?,
            ${agents.columns.last_activity_at} = ?
        WHERE ${agents.columns.id} = ?
      `,
      [JSON.stringify(data), now(), agentId]
    );
  }

  async readCheckpoint(agentId: string): Promise<unknown | null> {
    await this.ensureInitialized();
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    return agent.checkpoint;
  }

  // ── Done ───────────────────────────────────────────────────────────────

  async agentDone(agentId: string, input: AgentDoneInput): Promise<void> {
    await this.ensureInitialized();

    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Submit to review queue if agent has a hooked bead
    if (agent.current_hook_bead_id) {
      await this.submitToReviewQueue({
        agent_id: agentId,
        bead_id: agent.current_hook_bead_id,
        branch: input.branch,
        pr_url: input.pr_url,
        summary: input.summary,
      });
    }

    // Unhook and set to idle
    await this.unhookBead(agentId);

    await this.armAlarmIfNeeded();
  }

  // ── Town ID (links this rig to its town container) ─────────────────────

  async setTownId(townId: string): Promise<void> {
    await this.ctx.storage.put(TOWN_ID_KEY, townId);
    await this.armAlarmIfNeeded();
  }

  async getTownId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(TOWN_ID_KEY)) ?? null;
  }

  // ── Alarm ─────────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    await this.ensureInitialized();

    const scheduledAgents = await this.schedulePendingWork();
    const patrol = await this.witnessPatrol();
    const reviewProcessed = await this.processReviewQueue();

    // Re-arm with adaptive interval
    const nextAlarmMs = this.hasActiveWork() ? ACTIVE_ALARM_INTERVAL_MS : IDLE_ALARM_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Date.now() + nextAlarmMs);
  }

  /**
   * Arm the alarm if not already armed. Called when new work arrives
   * (hookBead, agentDone, heartbeat, setTownId).
   */
  private async armAlarmIfNeeded(): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }

  /**
   * Check whether there are active agents or pending beads/review entries.
   */
  private hasActiveWork(): boolean {
    const activeAgentRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(*) as cnt FROM ${agents}
          WHERE ${agents.columns.status} IN ('working', 'blocked')
        `,
        []
      ),
    ];

    const pendingBeadRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(*) as cnt FROM ${beads}
          WHERE ${beads.columns.status} = 'in_progress'
        `,
        []
      ),
    ];

    const pendingReviewRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(*) as cnt FROM ${reviewQueue}
          WHERE ${reviewQueue.columns.status} IN ('pending', 'running')
        `,
        []
      ),
    ];

    const activeAgents = Number(activeAgentRows[0]?.cnt ?? 0);
    const pendingBeads = Number(pendingBeadRows[0]?.cnt ?? 0);
    const pendingReviews = Number(pendingReviewRows[0]?.cnt ?? 0);

    return activeAgents > 0 || pendingBeads > 0 || pendingReviews > 0;
  }

  // ── Schedule Pending Work ─────────────────────────────────────────────

  /**
   * Find agents that have hooked beads but haven't been started in the container.
   * This covers two cases:
   *  1. Fresh hook: hookBead sets status='working' but no container process exists yet
   *  2. Crash recovery: witnessPatrol resets dead container agents to 'idle'
   *
   * We use cloud_agent_session_id IS NULL as the marker for "not yet dispatched".
   */
  private async schedulePendingWork(): Promise<string[]> {
    const pendingRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agents.columns.id},
                 ${agents.columns.name},
                 ${agents.columns.role},
                 ${agents.columns.identity},
                 ${agents.columns.current_hook_bead_id},
                 ${agents.columns.checkpoint}
          FROM ${agents}
          WHERE ${agents.columns.status} IN ('idle', 'working')
            AND ${agents.columns.current_hook_bead_id} IS NOT NULL
            AND ${agents.columns.cloud_agent_session_id} IS NULL
        `,
        []
      ),
    ];

    if (pendingRows.length === 0) return [];

    const townId = await this.getTownId();
    if (!townId) {
      console.warn('schedulePendingWork: no townId configured, skipping container dispatch');
      return [];
    }

    const scheduledAgentIds: string[] = [];

    for (const row of pendingRows) {
      const agentId = String(row.id);
      const beadId = String(row.current_hook_bead_id);
      const bead = this.getBead(beadId);
      if (!bead) continue;

      const started = await this.startAgentInContainer(townId, {
        agentId,
        agentName: String(row.name),
        role: String(row.role),
        identity: String(row.identity),
        beadId,
        beadTitle: bead.title,
        checkpoint: row.checkpoint ? String(row.checkpoint) : null,
      });

      if (started) {
        // Mark as working with a session ID so it won't be re-dispatched
        query(
          this.sql,
          /* sql */ `
            UPDATE ${agents}
            SET ${agents.columns.status} = 'working',
                ${agents.columns.cloud_agent_session_id} = ?,
                ${agents.columns.last_activity_at} = ?
            WHERE ${agents.columns.id} = ?
          `,
          [`container:${agentId}`, now(), agentId]
        );
        scheduledAgentIds.push(agentId);
      }
    }

    return scheduledAgentIds;
  }

  /**
   * Signal the container to start an agent process.
   * Returns true if the container accepted the request.
   */
  private async startAgentInContainer(
    townId: string,
    params: {
      agentId: string;
      agentName: string;
      role: string;
      identity: string;
      beadId: string;
      beadTitle: string;
      checkpoint: string | null;
    }
  ): Promise<boolean> {
    try {
      const container = getTownContainerStub(this.env, townId);
      const response = await container.fetch('http://container/agents/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: params.agentId,
          agent_name: params.agentName,
          role: params.role,
          identity: params.identity,
          bead_id: params.beadId,
          bead_title: params.beadTitle,
          checkpoint: params.checkpoint,
        }),
      });
      return response.ok;
    } catch (err) {
      console.error(`Failed to start agent ${params.agentId} in container:`, err);
      return false;
    }
  }

  // ── Process Review Queue ──────────────────────────────────────────────

  /**
   * Pop the next pending review entry and trigger merge in the container.
   */
  private async processReviewQueue(): Promise<boolean> {
    const entry = await this.popReviewQueue();
    if (!entry) return false;

    const townId = await this.getTownId();
    if (!townId) {
      console.warn('processReviewQueue: no townId configured, skipping merge');
      return false;
    }

    await this.startMergeInContainer(townId, entry);
    return true;
  }

  /**
   * Signal the container to run a deterministic merge for a review queue entry.
   */
  private async startMergeInContainer(townId: string, entry: ReviewQueueEntry): Promise<void> {
    try {
      const container = getTownContainerStub(this.env, townId);
      const response = await container.fetch('http://container/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entry_id: entry.id,
          branch: entry.branch,
          bead_id: entry.bead_id,
          agent_id: entry.agent_id,
          pr_url: entry.pr_url,
        }),
      });

      if (!response.ok) {
        console.error(`Merge request failed for entry ${entry.id}: ${response.status}`);
        await this.completeReview(entry.id, 'failed');
      }
      // On success, the container will call back to completeReview when merge finishes
    } catch (err) {
      console.error(`Failed to start merge for entry ${entry.id}:`, err);
      await this.completeReview(entry.id, 'failed');
    }
  }

  // ── Health (called by alarm) ──────────────────────────────────────────

  async witnessPatrol(): Promise<PatrolResult> {
    await this.ensureInitialized();

    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    const guppThreshold = new Date(Date.now() - GUPP_THRESHOLD_MS).toISOString();

    // Detect dead agents
    const deadRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agents.columns.id} FROM ${agents}
          WHERE ${agents.columns.status} = 'dead'
        `,
        []
      ),
    ];

    // Detect stale agents (working but no activity for STALE_THRESHOLD_MS)
    const staleRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agents.columns.id} FROM ${agents}
          WHERE ${agents.columns.status} = 'working'
            AND ${agents.columns.last_activity_at} < ?
        `,
        [staleThreshold]
      ),
    ];

    // Detect orphaned beads (in_progress with no live assignee)
    const orphanedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${beads.columns.id} FROM ${beads}
          WHERE ${beads.columns.status} = 'in_progress'
            AND (
              ${beads.columns.assignee_agent_id} IS NULL
              OR ${beads.columns.assignee_agent_id} NOT IN (
                SELECT ${agents.columns.id} FROM ${agents}
                WHERE ${agents.columns.status} != 'dead'
              )
            )
        `,
        []
      ),
    ];

    // Check container process health for working/blocked agents
    const townId = await this.getTownId();
    if (townId) {
      const workingRows = [
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${agents.columns.id},
                   ${agents.columns.current_hook_bead_id},
                   ${agents.columns.last_activity_at}
            FROM ${agents}
            WHERE ${agents.columns.status} IN ('working', 'blocked')
          `,
          []
        ),
      ];

      for (const row of workingRows) {
        const agentId = String(row.id);
        const containerStatus = await this.checkAgentContainerStatus(townId, agentId);

        if (containerStatus === 'not_found' || containerStatus === 'exited') {
          // Agent process is gone — reset to idle and clear session so
          // schedulePendingWork() can re-dispatch on the next alarm
          query(
            this.sql,
            /* sql */ `
              UPDATE ${agents}
              SET ${agents.columns.status} = 'idle',
                  ${agents.columns.cloud_agent_session_id} = NULL,
                  ${agents.columns.last_activity_at} = ?
              WHERE ${agents.columns.id} = ?
            `,
            [now(), agentId]
          );
          continue;
        }

        // GUPP violation check (30 min no progress)
        if (row.last_activity_at && String(row.last_activity_at) < guppThreshold) {
          await this.sendMail({
            from_agent_id: 'witness',
            to_agent_id: agentId,
            subject: 'GUPP_CHECK',
            body: 'You have had work hooked for 30+ minutes with no activity. Are you stuck? If so, call gt_escalate.',
          });
        }
      }
    }

    return {
      dead_agents: deadRows.map(r => String(r.id)),
      stale_agents: staleRows.map(r => String(r.id)),
      orphaned_beads: orphanedRows.map(r => String(r.id)),
    };
  }

  /**
   * Check the container for an agent's process status.
   * Returns the status string or 'unknown' on failure.
   */
  private async checkAgentContainerStatus(townId: string, agentId: string): Promise<string> {
    try {
      const container = getTownContainerStub(this.env, townId);
      const response = await container.fetch(`http://container/agents/${agentId}/status`);
      if (!response.ok) return 'unknown';
      const data = await response.json<{ status: string }>();
      return data.status;
    } catch {
      return 'unknown';
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────

  async touchAgentHeartbeat(agentId: string): Promise<void> {
    await this.ensureInitialized();
    this.touchAgent(agentId);
    await this.armAlarmIfNeeded();
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private touchAgent(agentId: string): void {
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agents}
        SET ${agents.columns.last_activity_at} = ?
        WHERE ${agents.columns.id} = ?
      `,
      [now(), agentId]
    );
  }
}

export function getRigDOStub(env: Env, rigId: string) {
  return env.RIG.get(env.RIG.idFromName(rigId));
}
