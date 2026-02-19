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
import {
  createTableAgentEvents,
  getIndexesAgentEvents,
  agentEvents,
  AgentEventRecord,
} from '../db/tables/agent-events.table';
import { getTownContainerStub } from './TownContainer.do';
import { query } from '../util/query.util';
import { signAgentJWT } from '../util/jwt.util';
import type {
  Bead,
  BeadStatus,
  CreateBeadInput,
  BeadFilter,
  Agent,
  AgentRole,
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

const RIG_LOG = '[Rig.do]';

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

// Alarm interval while there's active work (agents working, beads in progress, reviews pending)
const ACTIVE_ALARM_INTERVAL_MS = 30_000;

// Timeout for review entries stuck in 'running' state (container crashed mid-merge)
const REVIEW_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;

// Max consecutive dispatch attempts before marking a bead as failed
const MAX_DISPATCH_ATTEMPTS = 5;

// KV keys for rig configuration (stored in DO KV storage, not SQL)
const TOWN_ID_KEY = 'townId';
const RIG_CONFIG_KEY = 'rigConfig';

type RigConfig = {
  rigId?: string;
  townId: string;
  gitUrl: string;
  defaultBranch: string;
  userId: string;
  /** User's Kilo API token for LLM gateway access (generated via generateApiToken) */
  kilocodeToken?: string;
};

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

    query(this.sql, createTableAgentEvents(), []);
    for (const idx of getIndexesAgentEvents()) {
      query(this.sql, idx, []);
    }
  }

  // ── Beads ──────────────────────────────────────────────────────────────

  async createBead(input: CreateBeadInput): Promise<Bead> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();
    const labelsJson = JSON.stringify(input.labels ?? []);
    const metadataJson = JSON.stringify(input.metadata ?? {});

    console.log(
      `${RIG_LOG} createBead: id=${id} type=${input.type} title="${input.title?.slice(0, 80)}" assignee_agent_id=${input.assignee_agent_id ?? 'none'}`
    );

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
    console.log(`${RIG_LOG} createBead: created bead id=${result.id} status=${result.status}`);
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

  async deleteBead(beadId: string): Promise<boolean> {
    await this.ensureInitialized();
    const bead = this.getBead(beadId);
    if (!bead) return false;
    // Unhook any agent assigned to this bead
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agents}
        SET ${agents.columns.current_hook_bead_id} = NULL,
            ${agents.columns.status} = 'idle'
        WHERE ${agents.columns.current_hook_bead_id} = ?
      `,
      [beadId]
    );
    query(this.sql, /* sql */ `DELETE FROM ${beads} WHERE ${beads.columns.id} = ?`, [beadId]);
    return true;
  }

  // ── Agents ─────────────────────────────────────────────────────────────

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();

    console.log(
      `${RIG_LOG} registerAgent: id=${id} role=${input.role} name=${input.name} identity=${input.identity}`
    );

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
    console.log(
      `${RIG_LOG} registerAgent: created agent id=${agent.id} role=${agent.role} name=${agent.name} status=${agent.status}`
    );
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

  async deleteAgent(agentId: string): Promise<boolean> {
    await this.ensureInitialized();
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    // Unassign any beads assigned to this agent
    query(
      this.sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.assignee_agent_id} = NULL
        WHERE ${beads.columns.assignee_agent_id} = ?
      `,
      [agentId]
    );
    // Delete mail for this agent
    query(
      this.sql,
      /* sql */ `
        DELETE FROM ${mail}
        WHERE ${mail.columns.to_agent_id} = ? OR ${mail.columns.from_agent_id} = ?
      `,
      [agentId, agentId]
    );
    query(this.sql, /* sql */ `DELETE FROM ${agents} WHERE ${agents.columns.id} = ?`, [agentId]);
    return true;
  }

  // ── Hooks (GUPP) ──────────────────────────────────────────────────────

  async hookBead(agentId: string, beadId: string): Promise<void> {
    await this.ensureInitialized();
    console.log(`${RIG_LOG} hookBead: agentId=${agentId} beadId=${beadId}`);

    // Verify bead exists
    const bead = this.getBead(beadId);
    if (!bead) throw new Error(`Bead ${beadId} not found`);
    console.log(
      `${RIG_LOG} hookBead: bead exists, type=${bead.type} status=${bead.status} assignee=${bead.assignee_agent_id}`
    );

    // Verify agent exists
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    console.log(
      `${RIG_LOG} hookBead: agent exists, role=${agent.role} status=${agent.status} current_hook=${agent.current_hook_bead_id}`
    );

    // Check agent isn't already hooked to another bead
    if (agent.current_hook_bead_id && agent.current_hook_bead_id !== beadId) {
      console.error(
        `${RIG_LOG} hookBead: CONFLICT - agent ${agentId} already hooked to ${agent.current_hook_bead_id}`
      );
      throw new Error(`Agent ${agentId} is already hooked to bead ${agent.current_hook_bead_id}`);
    }

    query(
      this.sql,
      /* sql */ `
        UPDATE ${agents}
        SET ${agents.columns.current_hook_bead_id} = ?,
            ${agents.columns.dispatch_attempts} = 0,
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

    console.log(
      `${RIG_LOG} hookBead: bead ${beadId} now in_progress, agent ${agentId} hooked. Arming alarm.`
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

  // ── Agent Events (append-only log for streaming) ────────────────────────

  /** Max events kept per agent. Older events are pruned on insert. */
  private static readonly MAX_EVENTS_PER_AGENT = 2000;

  /**
   * Append an event to the agent's event log. Used by the container
   * completion callback or the streaming proxy to persist events for
   * late-joining clients.
   */
  async appendAgentEvent(agentId: string, eventType: string, data: unknown): Promise<void> {
    await this.ensureInitialized();
    const timestamp = now();
    const dataJson = JSON.stringify(data ?? {});

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${agentEvents} (
          ${agentEvents.columns.agent_id},
          ${agentEvents.columns.event_type},
          ${agentEvents.columns.data},
          ${agentEvents.columns.created_at}
        ) VALUES (?, ?, ?, ?)`,
      [agentId, eventType, dataJson, timestamp]
    );

    // Prune old events beyond the cap
    query(
      this.sql,
      /* sql */ `
        DELETE FROM ${agentEvents}
        WHERE ${agentEvents.agent_id} = ?
          AND ${agentEvents.id} NOT IN (
            SELECT ${agentEvents.id} FROM ${agentEvents}
            WHERE ${agentEvents.agent_id} = ?
            ORDER BY ${agentEvents.id} DESC
            LIMIT ?
          )`,
      [agentId, agentId, RigDO.MAX_EVENTS_PER_AGENT]
    );
  }

  /**
   * Get agent events, optionally after a given event id (for catch-up).
   * Returns events ordered by id ascending.
   */
  async getAgentEvents(
    agentId: string,
    afterId?: number,
    limit = 200
  ): Promise<AgentEventRecord[]> {
    await this.ensureInitialized();

    const rows = query(
      this.sql,
      /* sql */ `
        SELECT ${agentEvents.id}, ${agentEvents.agent_id}, ${agentEvents.event_type},
               ${agentEvents.data}, ${agentEvents.created_at}
        FROM ${agentEvents}
        WHERE ${agentEvents.agent_id} = ?
          AND (? IS NULL OR ${agentEvents.id} > ?)
        ORDER BY ${agentEvents.id} ASC
        LIMIT ?`,
      [agentId, afterId ?? null, afterId ?? null, limit]
    );

    return AgentEventRecord.array().parse(rows);
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

  // ── Agent Completed (container callback) ─────────────────────────────────

  /**
   * Called by the container when an agent session completes or fails.
   * Closes the bead if the agent completed successfully, or marks it
   * as failed if the agent errored. Unhooks the agent in both cases.
   *
   * Unlike `agentDone` (called by the agent itself via gt_done tool),
   * this is called by the container's process manager when it detects
   * session completion via SSE events.
   */
  async agentCompleted(
    agentId: string,
    input: { status: 'completed' | 'failed'; reason?: string }
  ): Promise<void> {
    await this.ensureInitialized();

    const agent = this.getAgent(agentId);
    if (!agent) {
      console.warn(`${RIG_LOG} agentCompleted: agent ${agentId} not found, ignoring`);
      return;
    }

    const beadId = agent.current_hook_bead_id;
    if (beadId) {
      const beadStatus = input.status === 'completed' ? 'closed' : 'failed';
      console.log(
        `${RIG_LOG} agentCompleted: agent ${agentId} ${input.status}, transitioning bead ${beadId} to '${beadStatus}'`
      );
      const timestamp = now();
      const closedAt = beadStatus === 'closed' ? timestamp : null;
      query(
        this.sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.status} = ?,
              ${beads.columns.updated_at} = ?,
              ${beads.columns.closed_at} = COALESCE(?, ${beads.columns.closed_at})
          WHERE ${beads.columns.id} = ?
        `,
        [beadStatus, timestamp, closedAt, beadId]
      );
    } else {
      console.log(`${RIG_LOG} agentCompleted: agent ${agentId} ${input.status} but no hooked bead`);
    }

    // Unhook and set to idle
    await this.unhookBead(agentId);
    await this.armAlarmIfNeeded();
  }

  // ── Atomic Sling ────────────────────────────────────────────────────────
  // Creates bead, assigns or reuses an idle polecat, hooks them together,
  // and arms the alarm — all within a single DO call to avoid TOCTOU races.

  async slingBead(input: {
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ bead: Bead; agent: Agent }> {
    await this.ensureInitialized();
    console.log(
      `${RIG_LOG} slingBead: title="${input.title?.slice(0, 80)}" metadata=${JSON.stringify(input.metadata)}`
    );

    // Create the bead
    const bead = await this.createBead({
      type: 'issue',
      title: input.title,
      body: input.body,
      metadata: input.metadata,
    });
    console.log(`${RIG_LOG} slingBead: bead created id=${bead.id}`);

    // Find an idle polecat or create one
    const agent = await this.getOrCreateAgent('polecat');
    console.log(`${RIG_LOG} slingBead: agent=${agent.id} role=${agent.role} name=${agent.name}`);

    // Hook them together (also arms the alarm)
    await this.hookBead(agent.id, bead.id);
    console.log(`${RIG_LOG} slingBead: hooked agent ${agent.id} to bead ${bead.id}`);

    const updatedBead = await this.getBeadAsync(bead.id);
    const updatedAgent = this.getAgent(agent.id);
    if (!updatedBead || !updatedAgent) {
      throw new Error(`slingBead: failed to re-fetch bead ${bead.id} or agent ${agent.id}`);
    }
    console.log(
      `${RIG_LOG} slingBead: complete bead.status=${updatedBead.status} agent.status=${updatedAgent.status} agent.current_hook=${updatedAgent.current_hook_bead_id}`
    );
    return { bead: updatedBead, agent: updatedAgent };
  }

  // ── Get or Create Agent ────────────────────────────────────────────────
  // Atomically finds an existing agent of the given role (idle preferred)
  // or creates a new one. Prevents duplicate agent creation from concurrent calls.
  // Singleton roles (witness, refinery) always return the existing
  // agent even if busy — only polecats scale out by creating new agents.
  private static readonly SINGLETON_ROLES: ReadonlySet<string> = new Set(['witness', 'refinery']);

  async getOrCreateAgent(role: AgentRole): Promise<Agent> {
    await this.ensureInitialized();
    console.log(`${RIG_LOG} getOrCreateAgent: role=${role}`);

    const existing = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${agents}
          WHERE ${agents.columns.role} = ?
          ORDER BY CASE WHEN ${agents.columns.status} = 'idle' THEN 0 ELSE 1 END,
                   ${agents.columns.last_activity_at} ASC
          LIMIT ?
        `,
        [role, 1]
      ),
    ];

    if (existing.length > 0) {
      const agent = AgentRecord.parse(existing[0]);
      console.log(
        `${RIG_LOG} getOrCreateAgent: found existing agent id=${agent.id} name=${agent.name} role=${agent.role} status=${agent.status} current_hook=${agent.current_hook_bead_id}`
      );
      // Singleton roles: return existing agent regardless of status
      if (agent.status === 'idle' || RigDO.SINGLETON_ROLES.has(role)) {
        console.log(
          `${RIG_LOG} getOrCreateAgent: returning existing agent (idle=${agent.status === 'idle'}, singleton=${RigDO.SINGLETON_ROLES.has(role)})`
        );
        return agent;
      }
    } else {
      console.log(`${RIG_LOG} getOrCreateAgent: no existing agent found for role=${role}`);
    }

    // No idle agent found (polecat) or no agent at all — create a new one
    console.log(`${RIG_LOG} getOrCreateAgent: creating new agent for role=${role}`);
    return this.registerAgent({
      role,
      name: `${role}-${Date.now()}`,
      identity: `${role}-${generateId()}`,
    });
  }

  // ── Rig configuration (links this rig to its town + git repo) ────────

  async configureRig(config: RigConfig): Promise<void> {
    // Auto-populate rigId from the DO name if not provided by the caller
    const rigId = config.rigId ?? this.ctx.id.name ?? undefined;
    const enriched = { ...config, rigId };
    console.log(
      `${RIG_LOG} configureRig: rigId=${rigId} townId=${config.townId} gitUrl=${config.gitUrl} defaultBranch=${config.defaultBranch} userId=${config.userId}`
    );
    await this.ctx.storage.put(RIG_CONFIG_KEY, enriched);
    // Also store townId under the legacy key for backward compat
    await this.ctx.storage.put(TOWN_ID_KEY, config.townId);
    await this.armAlarmIfNeeded();
  }

  async getRigConfig(): Promise<RigConfig | null> {
    return (await this.ctx.storage.get<RigConfig>(RIG_CONFIG_KEY)) ?? null;
  }

  /** @deprecated Use configureRig() instead. Kept for test compat. */
  async setTownId(townId: string): Promise<void> {
    // Minimal fallback: store only townId (other fields remain empty).
    // Production code should always use configureRig().
    const existing = await this.getRigConfig();
    if (existing) {
      existing.townId = townId;
      await this.ctx.storage.put(RIG_CONFIG_KEY, existing);
    } else {
      await this.ctx.storage.put(RIG_CONFIG_KEY, {
        townId,
        gitUrl: '',
        defaultBranch: 'main',
        userId: '',
      } satisfies RigConfig);
    }
    await this.ctx.storage.put(TOWN_ID_KEY, townId);
    await this.armAlarmIfNeeded();
  }

  async getTownId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(TOWN_ID_KEY)) ?? null;
  }

  // ── Alarm ─────────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    await this.ensureInitialized();
    console.log(`${RIG_LOG} alarm: fired at ${now()}`);

    // witnessPatrol first: resets dead-container agents to idle so
    // schedulePendingWork can re-dispatch them in the same tick
    console.log(`${RIG_LOG} alarm: running witnessPatrol`);
    const patrolResult = await this.witnessPatrol();
    console.log(
      `${RIG_LOG} alarm: witnessPatrol done dead=${patrolResult.dead_agents.length} stale=${patrolResult.stale_agents.length} orphaned=${patrolResult.orphaned_beads.length}`
    );

    console.log(`${RIG_LOG} alarm: running schedulePendingWork`);
    const scheduled = await this.schedulePendingWork();
    console.log(
      `${RIG_LOG} alarm: schedulePendingWork done, scheduled ${scheduled.length} agents: [${scheduled.join(', ')}]`
    );

    console.log(`${RIG_LOG} alarm: running processReviewQueue`);
    const reviewProcessed = await this.processReviewQueue();
    console.log(`${RIG_LOG} alarm: processReviewQueue done, processed=${reviewProcessed}`);

    // Only re-arm if there's active work; armAlarmIfNeeded() restarts
    // the loop when new work arrives
    const active = this.hasActiveWork();
    console.log(`${RIG_LOG} alarm: hasActiveWork=${active}`);
    if (active) {
      console.log(`${RIG_LOG} alarm: re-arming alarm for ${ACTIVE_ALARM_INTERVAL_MS}ms`);
      await this.ctx.storage.setAlarm(Date.now() + ACTIVE_ALARM_INTERVAL_MS);
    } else {
      console.log(`${RIG_LOG} alarm: no active work, NOT re-arming`);
    }
  }

  /**
   * Arm the alarm if not already armed. Called when new work arrives
   * (hookBead, agentDone, heartbeat, setTownId).
   */
  private async armAlarmIfNeeded(): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || currentAlarm < Date.now()) {
      console.log(
        `${RIG_LOG} armAlarmIfNeeded: ${currentAlarm ? `stale alarm at ${new Date(currentAlarm).toISOString()}, re-arming` : 'no current alarm, arming'} for 5s from now`
      );
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    } else {
      console.log(
        `${RIG_LOG} armAlarmIfNeeded: alarm already set for ${new Date(currentAlarm).toISOString()}`
      );
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

    console.log(
      `${RIG_LOG} hasActiveWork: activeAgents=${activeAgents} pendingBeads=${pendingBeads} pendingReviews=${pendingReviews}`
    );
    return activeAgents > 0 || pendingBeads > 0 || pendingReviews > 0;
  }

  // ── Schedule Pending Work ─────────────────────────────────────────────

  /**
   * Find idle agents that have hooked beads and dispatch them to the container.
   * Covers fresh hooks and crash recovery (witnessPatrol resets dead agents to idle).
   * The scheduler is the only path that transitions an agent to 'working'.
   */
  private async schedulePendingWork(): Promise<string[]> {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${agents}
          WHERE ${agents.columns.status} = 'idle'
            AND ${agents.columns.current_hook_bead_id} IS NOT NULL
        `,
        []
      ),
    ];
    const pendingAgents = AgentRecord.array().parse(rows);
    console.log(
      `${RIG_LOG} schedulePendingWork: found ${pendingAgents.length} idle agents with hooked beads`
    );

    if (pendingAgents.length === 0) return [];

    for (const agent of pendingAgents) {
      console.log(
        `${RIG_LOG} schedulePendingWork: agent id=${agent.id} role=${agent.role} name=${agent.name} status=${agent.status} hook=${agent.current_hook_bead_id}`
      );
    }

    const config = await this.getRigConfig();
    if (!config?.townId) {
      console.warn(
        `${RIG_LOG} schedulePendingWork: rig not configured (no townId), skipping container dispatch`
      );
      return [];
    }
    console.log(
      `${RIG_LOG} schedulePendingWork: rig config townId=${config.townId} gitUrl=${config.gitUrl} defaultBranch=${config.defaultBranch}`
    );

    const scheduledAgentIds: string[] = [];

    for (const agent of pendingAgents) {
      const beadId = agent.current_hook_bead_id;
      if (!beadId) continue;
      const bead = this.getBead(beadId);
      if (!bead) {
        console.warn(
          `${RIG_LOG} schedulePendingWork: bead ${beadId} not found for agent ${agent.id}, skipping`
        );
        continue;
      }

      // Circuit breaker: if this agent has exceeded max dispatch attempts,
      // mark the bead as failed and unhook the agent to stop retrying.
      const attempts = agent.dispatch_attempts + 1;
      if (attempts > MAX_DISPATCH_ATTEMPTS) {
        console.error(
          `${RIG_LOG} schedulePendingWork: agent ${agent.id} exceeded ${MAX_DISPATCH_ATTEMPTS} dispatch attempts for bead ${beadId}, marking bead as failed`
        );
        query(
          this.sql,
          /* sql */ `
            UPDATE ${beads}
            SET ${beads.columns.status} = 'failed',
                ${beads.columns.updated_at} = ?
            WHERE ${beads.columns.id} = ?
          `,
          [now(), beadId]
        );
        await this.unhookBead(agent.id);
        continue;
      }

      // Increment dispatch_attempts before attempting
      query(
        this.sql,
        /* sql */ `
          UPDATE ${agents}
          SET ${agents.columns.dispatch_attempts} = ?
          WHERE ${agents.columns.id} = ?
        `,
        [attempts, agent.id]
      );

      console.log(
        `${RIG_LOG} schedulePendingWork: dispatching agent ${agent.id} (${agent.role}/${agent.name}) to container for bead "${bead.title?.slice(0, 60)}" (attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS})`
      );
      const started = await this.startAgentInContainer(config, {
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        identity: agent.identity,
        beadId,
        beadTitle: bead.title,
        beadBody: bead.body ?? '',
        checkpoint: agent.checkpoint ?? null,
      });

      if (started) {
        console.log(
          `${RIG_LOG} schedulePendingWork: agent ${agent.id} started in container, marking as 'working'`
        );
        // Reset dispatch_attempts on successful start
        query(
          this.sql,
          /* sql */ `
            UPDATE ${agents}
            SET ${agents.columns.status} = 'working',
                ${agents.columns.dispatch_attempts} = 0,
                ${agents.columns.last_activity_at} = ?
            WHERE ${agents.columns.id} = ?
          `,
          [now(), agent.id]
        );
        scheduledAgentIds.push(agent.id);
      } else {
        console.error(
          `${RIG_LOG} schedulePendingWork: FAILED to start agent ${agent.id} in container (attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS})`
        );
      }
    }

    return scheduledAgentIds;
  }

  // ── Container dispatch helpers ──────────────────────────────────────

  /**
   * Resolve the GASTOWN_JWT_SECRET binding to a string.
   * Returns null if the secret is not configured.
   */
  private async resolveJWTSecret(): Promise<string | null> {
    const binding = this.env.GASTOWN_JWT_SECRET;
    if (!binding) return null;
    if (typeof binding === 'string') return binding;
    try {
      return await binding.get();
    } catch {
      console.error('Failed to resolve GASTOWN_JWT_SECRET');
      return null;
    }
  }

  /**
   * Mint a short-lived agent JWT for the given agent to authenticate
   * API calls back to the gastown worker.
   */
  private async mintAgentToken(agentId: string, config: RigConfig): Promise<string | null> {
    const secret = await this.resolveJWTSecret();
    if (!secret) return null;

    const rigId = this.ctx.id.name ?? config.rigId;
    if (!rigId) {
      console.error('mintAgentToken: DO has no name (rigId) and config has no rigId');
      return null;
    }

    // 8h expiry — long enough for typical agent sessions, short enough to
    // limit blast radius. The alarm re-dispatches work every 30s so a new
    // token is minted on each dispatch.
    return signAgentJWT(
      { agentId, rigId, townId: config.townId, userId: config.userId },
      secret,
      8 * 3600
    );
  }

  /** Build the initial prompt for an agent from its bead. */
  private static buildPrompt(params: {
    beadTitle: string;
    beadBody: string;
    checkpoint: unknown;
  }): string {
    const parts: string[] = [params.beadTitle];
    if (params.beadBody) parts.push(params.beadBody);
    if (params.checkpoint) {
      parts.push(
        `Resume from checkpoint:\n${typeof params.checkpoint === 'string' ? params.checkpoint : JSON.stringify(params.checkpoint)}`
      );
    }
    return parts.join('\n\n');
  }

  /** Default system prompt per agent role. */
  private static systemPromptForRole(role: string, identity: string): string {
    const base = `You are ${identity}, a Gastown ${role} agent. Follow all instructions in the GASTOWN CONTEXT injected into this session.`;
    switch (role) {
      case 'polecat':
        return `${base} Your job is to implement the assigned task on a feature branch, write clean code, and call gt_done when finished.`;
      case 'mayor':
        return `${base} You coordinate work across the town. Respond to messages and delegate tasks via gt_mail_send.`;
      case 'refinery':
        return `${base} You review code quality and merge PRs. Check for correctness, style, and test coverage.`;
      case 'witness':
        return `${base} You monitor agent health and report anomalies.`;
      default:
        return base;
    }
  }

  /** Default model for agent roles. */
  private static modelForRole(role: string): string {
    switch (role) {
      case 'polecat':
        return 'kilo/claude-sonnet-4-20250514';
      case 'refinery':
        return 'kilo/claude-sonnet-4-20250514';
      case 'mayor':
        return 'kilo/claude-sonnet-4-20250514';
      default:
        return 'kilo/claude-sonnet-4-20250514';
    }
  }

  /** Generate a branch name for an agent. */
  private static branchForAgent(name: string): string {
    // Sanitize agent name → branch-safe slug
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-');
    return `gt/${slug}`;
  }

  /**
   * Signal the container to start an agent process.
   * Sends the full StartAgentRequest shape expected by the container.
   * Returns true if the container accepted the request.
   */
  private async startAgentInContainer(
    config: RigConfig,
    params: {
      agentId: string;
      agentName: string;
      role: string;
      identity: string;
      beadId: string;
      beadTitle: string;
      beadBody: string;
      checkpoint: unknown;
    }
  ): Promise<boolean> {
    console.log(
      `${RIG_LOG} startAgentInContainer: agentId=${params.agentId} role=${params.role} name=${params.agentName} beadId=${params.beadId} townId=${config.townId}`
    );
    try {
      const token = await this.mintAgentToken(params.agentId, config);
      console.log(`${RIG_LOG} startAgentInContainer: JWT minted=${!!token}`);

      const envVars: Record<string, string> = {};
      if (token) {
        envVars.GASTOWN_SESSION_TOKEN = token;
      }

      // Pass LLM gateway credentials so kilo serve can route inference calls
      if (this.env.KILO_API_URL) {
        envVars.KILO_API_URL = this.env.KILO_API_URL;
      }
      if (config.kilocodeToken) {
        envVars.KILOCODE_TOKEN = config.kilocodeToken;
      }

      const rigId = this.ctx.id.name ?? config.rigId ?? '';
      console.log(
        `${RIG_LOG} startAgentInContainer: rigId=${rigId} gitUrl=${config.gitUrl} branch=${RigDO.branchForAgent(params.agentName)}`
      );

      const prompt = RigDO.buildPrompt({
        beadTitle: params.beadTitle,
        beadBody: params.beadBody,
        checkpoint: params.checkpoint,
      });
      console.log(`${RIG_LOG} startAgentInContainer: prompt="${prompt.slice(0, 200)}"`);

      const container = getTownContainerStub(this.env, config.townId);
      console.log(`${RIG_LOG} startAgentInContainer: sending POST to container /agents/start`);
      const response = await container.fetch('http://container/agents/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: params.agentId,
          rigId,
          townId: config.townId,
          role: params.role,
          name: params.agentName,
          identity: params.identity,
          prompt,
          model: RigDO.modelForRole(params.role),
          systemPrompt: RigDO.systemPromptForRole(params.role, params.identity),
          gitUrl: config.gitUrl,
          branch: RigDO.branchForAgent(params.agentName),
          defaultBranch: config.defaultBranch,
          envVars,
        }),
      });
      console.log(
        `${RIG_LOG} startAgentInContainer: response status=${response.status} ok=${response.ok}`
      );
      if (!response.ok) {
        const text = await response.text().catch(() => '(unreadable)');
        console.error(`${RIG_LOG} startAgentInContainer: error response: ${text.slice(0, 500)}`);
      }
      return response.ok;
    } catch (err) {
      console.error(
        `${RIG_LOG} startAgentInContainer: EXCEPTION for agent ${params.agentId}:`,
        err
      );
      return false;
    }
  }

  // ── Process Review Queue ──────────────────────────────────────────────

  /**
   * Check for a pending review entry and trigger merge in the container.
   * Also recovers entries stuck in 'running' for longer than REVIEW_RUNNING_TIMEOUT_MS.
   * Checks townId before popping to avoid losing entries.
   */
  private async processReviewQueue(): Promise<boolean> {
    this.recoverStuckReviews();

    const config = await this.getRigConfig();
    if (!config?.townId) return false;

    const entry = await this.popReviewQueue();
    if (!entry) return false;

    await this.startMergeInContainer(config, entry);
    return true;
  }

  /**
   * Reset review entries stuck in 'running' past the timeout back to 'pending'
   * so they can be retried.
   */
  private recoverStuckReviews(): void {
    const timeout = new Date(Date.now() - REVIEW_RUNNING_TIMEOUT_MS).toISOString();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${reviewQueue}
        SET ${reviewQueue.columns.status} = 'pending',
            ${reviewQueue.columns.processed_at} = NULL
        WHERE ${reviewQueue.columns.status} = 'running'
          AND ${reviewQueue.columns.processed_at} < ?
      `,
      [timeout]
    );
  }

  /**
   * Signal the container to run a deterministic merge for a review queue entry.
   */
  private async startMergeInContainer(config: RigConfig, entry: ReviewQueueEntry): Promise<void> {
    try {
      const token = await this.mintAgentToken(entry.agent_id, config);

      const envVars: Record<string, string> = {};
      if (token) {
        envVars.GASTOWN_SESSION_TOKEN = token;
      }
      if (this.env.KILO_API_URL) {
        envVars.KILO_API_URL = this.env.KILO_API_URL;
      }
      if (config.kilocodeToken) {
        envVars.KILOCODE_TOKEN = config.kilocodeToken;
      }

      const container = getTownContainerStub(this.env, config.townId);
      const response = await container.fetch('http://container/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entry_id: entry.id,
          branch: entry.branch,
          bead_id: entry.bead_id,
          agent_id: entry.agent_id,
          pr_url: entry.pr_url,
          envVars,
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
    console.log(`${RIG_LOG} witnessPatrol: starting`);

    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    const guppThreshold = new Date(Date.now() - GUPP_THRESHOLD_MS).toISOString();

    const AgentId = AgentRecord.pick({ id: true });
    const BeadId = BeadRecord.pick({ id: true });

    // Detect dead agents
    const deadAgents = AgentId.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agents.columns.id} FROM ${agents}
          WHERE ${agents.columns.status} = 'dead'
        `,
        []
      ),
    ]);

    // Detect stale agents (working but no activity for STALE_THRESHOLD_MS)
    const staleAgents = AgentId.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agents.columns.id} FROM ${agents}
          WHERE ${agents.columns.status} = 'working'
            AND ${agents.columns.last_activity_at} < ?
        `,
        [staleThreshold]
      ),
    ]);

    // Detect orphaned beads (in_progress with no live assignee)
    const orphanedBeads = BeadId.array().parse([
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
    ]);

    // Check container process health for working/blocked agents
    const townId = await this.getTownId();
    if (townId) {
      const WorkingAgent = AgentRecord.pick({
        id: true,
        current_hook_bead_id: true,
        last_activity_at: true,
      });
      const workingAgents = WorkingAgent.array().parse([
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
      ]);

      const MailId = MailRecord.pick({ id: true });

      console.log(
        `${RIG_LOG} witnessPatrol: checking ${workingAgents.length} working/blocked agents in container`
      );
      for (const working of workingAgents) {
        const containerInfo = await this.checkAgentContainerStatus(townId, working.id);
        console.log(
          `${RIG_LOG} witnessPatrol: agent ${working.id} container status=${containerInfo.status} exitReason=${containerInfo.exitReason ?? 'none'}`
        );

        if (containerInfo.status === 'not_found' || containerInfo.status === 'exited') {
          // If the agent completed successfully, close the bead instead of
          // resetting to idle (which would cause re-dispatch).
          if (containerInfo.exitReason === 'completed') {
            console.log(
              `${RIG_LOG} witnessPatrol: agent ${working.id} completed, closing bead via agentCompleted`
            );
            await this.agentCompleted(working.id, { status: 'completed' });
            continue;
          }

          console.log(
            `${RIG_LOG} witnessPatrol: agent ${working.id} process gone (${containerInfo.status}), resetting to idle for re-dispatch`
          );
          // Agent process is gone without completing — reset to idle so
          // schedulePendingWork() can re-dispatch on the next alarm tick.
          // The dispatch_attempts counter tracks retries.
          query(
            this.sql,
            /* sql */ `
              UPDATE ${agents}
              SET ${agents.columns.status} = 'idle',
                  ${agents.columns.last_activity_at} = ?
              WHERE ${agents.columns.id} = ?
            `,
            [now(), working.id]
          );
          continue;
        }

        // GUPP violation check (30 min no progress).
        // Only send if no undelivered GUPP_CHECK mail already exists for this agent.
        if (working.last_activity_at && working.last_activity_at < guppThreshold) {
          const existingGupp = MailId.array().parse([
            ...query(
              this.sql,
              /* sql */ `
                SELECT ${mail.columns.id} FROM ${mail}
                WHERE ${mail.columns.to_agent_id} = ?
                  AND ${mail.columns.subject} = 'GUPP_CHECK'
                  AND ${mail.columns.delivered} = 0
                LIMIT 1
              `,
              [working.id]
            ),
          ]);

          if (existingGupp.length === 0) {
            await this.sendMail({
              from_agent_id: 'witness',
              to_agent_id: working.id,
              subject: 'GUPP_CHECK',
              body: 'You have had work hooked for 30+ minutes with no activity. Are you stuck? If so, call gt_escalate.',
            });
          }
        }
      }
    }

    return {
      dead_agents: deadAgents.map(a => a.id),
      stale_agents: staleAgents.map(a => a.id),
      orphaned_beads: orphanedBeads.map(b => b.id),
    };
  }

  /**
   * Check the container for an agent's process status.
   * Returns the status and exit reason, or 'unknown' on failure.
   */
  private async checkAgentContainerStatus(
    townId: string,
    agentId: string
  ): Promise<{ status: string; exitReason?: string }> {
    try {
      const container = getTownContainerStub(this.env, townId);
      const response = await container.fetch(`http://container/agents/${agentId}/status`);
      if (!response.ok) return { status: 'unknown' };
      const data = await response.json<{ status: string; exitReason?: string }>();
      return { status: data.status, exitReason: data.exitReason ?? undefined };
    } catch {
      return { status: 'unknown' };
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────

  async touchAgentHeartbeat(agentId: string): Promise<void> {
    await this.ensureInitialized();
    this.touchAgent(agentId);
    await this.armAlarmIfNeeded();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Delete all storage and cancel alarms. Called when the rig is deleted
   * to prevent orphaned alarms from firing indefinitely.
   */
  async destroy(): Promise<void> {
    console.log(`${RIG_LOG} destroy: clearing all storage and alarms`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
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
