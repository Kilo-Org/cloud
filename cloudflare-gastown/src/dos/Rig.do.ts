import { DurableObject } from 'cloudflare:workers';
import {
  createTableRigBeads,
  getIndexesRigBeads,
  rig_beads,
  RigBeadRecord,
} from '../db/tables/rig-beads.table';
import { createTableRigAgents, rig_agents, RigAgentRecord } from '../db/tables/rig-agents.table';
import {
  createTableRigMail,
  getIndexesRigMail,
  rig_mail,
  RigMailRecord,
} from '../db/tables/rig-mail.table';
import {
  createTableRigReviewQueue,
  rig_review_queue,
  RigReviewQueueRecord,
} from '../db/tables/rig-review-queue.table';
import {
  createTableRigMolecules,
  rig_molecules,
  RigMoleculeRecord,
} from '../db/tables/rig-molecules.table';
import { z } from 'zod';
import {
  createTableRigBeadEvents,
  getIndexesRigBeadEvents,
  rig_bead_events,
  RigBeadEventRecord,
} from '../db/tables/rig-bead-events.table';
import type { BeadEventType } from '../db/tables/rig-bead-events.table';
import {
  createTableRigAgentEvents,
  getIndexesRigAgentEvents,
  rig_agent_events,
  RigAgentEventRecord,
} from '../db/tables/rig-agent-events.table';
import { getTownContainerStub } from './TownContainer.do';
import { getTownDOStub } from './Town.do';
import { query } from '../util/query.util';
import { signAgentJWT } from '../util/jwt.util';
import { buildPolecatSystemPrompt } from '../prompts/polecat-system.prompt';
import { buildMayorSystemPrompt } from '../prompts/mayor-system.prompt';
import { buildRefinerySystemPrompt } from '../prompts/refinery-system.prompt';
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
  TownConfig,
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

// Default max concurrent polecats per rig (overridable via TownConfig.max_polecats_per_rig)
const DEFAULT_MAX_POLECATS = 5;

// Polecat name pool — human-readable, unique, memorable names.
// Names are assigned sequentially; recycled when polecats are deleted.
const POLECAT_NAMES = [
  'Toast',
  'Maple',
  'Birch',
  'Shadow',
  'Copper',
  'Ember',
  'Frost',
  'Sage',
  'Flint',
  'Cedar',
  'Dusk',
  'Slate',
  'Thorn',
  'Drift',
  'Spark',
  'Onyx',
  'Moss',
  'Rust',
  'Wren',
  'Quartz',
] as const;

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
    query(this.sql, createTableRigBeads(), []);
    for (const idx of getIndexesRigBeads()) {
      query(this.sql, idx, []);
    }

    query(this.sql, createTableRigAgents(), []);
    query(this.sql, createTableRigMail(), []);
    for (const idx of getIndexesRigMail()) {
      query(this.sql, idx, []);
    }

    query(this.sql, createTableRigReviewQueue(), []);
    query(this.sql, createTableRigMolecules(), []);

    query(this.sql, createTableRigAgentEvents(), []);
    for (const idx of getIndexesRigAgentEvents()) {
      query(this.sql, idx, []);
    }

    query(this.sql, createTableRigBeadEvents(), []);
    for (const idx of getIndexesRigBeadEvents()) {
      query(this.sql, idx, []);
    }
  }

  // ── Bead Event Log ───────────────────────────────────────────────────

  private writeBeadEvent(params: {
    beadId: string;
    agentId?: string | null;
    eventType: BeadEventType;
    oldValue?: string | null;
    newValue?: string | null;
    metadata?: Record<string, unknown>;
  }): void {
    const id = generateId();
    const timestamp = now();
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${rig_bead_events} (
          ${rig_bead_events.columns.id},
          ${rig_bead_events.columns.bead_id},
          ${rig_bead_events.columns.agent_id},
          ${rig_bead_events.columns.event_type},
          ${rig_bead_events.columns.old_value},
          ${rig_bead_events.columns.new_value},
          ${rig_bead_events.columns.metadata},
          ${rig_bead_events.columns.created_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        params.beadId,
        params.agentId ?? null,
        params.eventType,
        params.oldValue ?? null,
        params.newValue ?? null,
        JSON.stringify(params.metadata ?? {}),
        timestamp,
      ]
    );
  }

  async listBeadEvents(options: {
    beadId?: string;
    since?: string;
    limit?: number;
  }): Promise<RigBeadEventRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${rig_bead_events}
          WHERE (? IS NULL OR ${rig_bead_events.bead_id} = ?)
            AND (? IS NULL OR ${rig_bead_events.created_at} > ?)
          ORDER BY ${rig_bead_events.created_at} ASC
          LIMIT ?
        `,
        [
          options.beadId ?? null,
          options.beadId ?? null,
          options.since ?? null,
          options.since ?? null,
          options.limit ?? 100,
        ]
      ),
    ];
    return RigBeadEventRecord.array().parse(rows);
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
        INSERT INTO ${rig_beads} (
          ${rig_beads.columns.id},
          ${rig_beads.columns.type},
          ${rig_beads.columns.status},
          ${rig_beads.columns.title},
          ${rig_beads.columns.body},
          ${rig_beads.columns.assignee_agent_id},
          ${rig_beads.columns.convoy_id},
          ${rig_beads.columns.priority},
          ${rig_beads.columns.labels},
          ${rig_beads.columns.metadata},
          ${rig_beads.columns.created_at},
          ${rig_beads.columns.updated_at}
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

    this.writeBeadEvent({
      beadId: id,
      agentId: input.assignee_agent_id,
      eventType: 'created',
      newValue: input.type,
      metadata: { title: input.title, priority: input.priority ?? 'medium' },
    });

    console.log(`${RIG_LOG} createBead: created bead id=${result.id} status=${result.status}`);
    return result;
  }

  async getBeadAsync(beadId: string): Promise<Bead | null> {
    await this.ensureInitialized();
    return this.getBead(beadId);
  }

  private getBead(beadId: string): Bead | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${rig_beads} WHERE ${rig_beads.columns.id} = ?`, [
        beadId,
      ]),
    ];
    if (rows.length === 0) return null;
    return RigBeadRecord.parse(rows[0]);
  }

  async listBeads(filter: BeadFilter): Promise<Bead[]> {
    await this.ensureInitialized();

    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${rig_beads}
          WHERE (? IS NULL OR ${rig_beads.columns.status} = ?)
            AND (? IS NULL OR ${rig_beads.columns.type} = ?)
            AND (? IS NULL OR ${rig_beads.columns.assignee_agent_id} = ?)
            AND (? IS NULL OR ${rig_beads.columns.convoy_id} = ?)
          ORDER BY ${rig_beads.columns.created_at} DESC
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
    return RigBeadRecord.array().parse(rows);
  }

  async updateBeadStatus(beadId: string, status: BeadStatus, agentId: string): Promise<Bead> {
    await this.ensureInitialized();
    const oldBead = this.getBead(beadId);
    const oldStatus = oldBead?.status ?? null;
    const timestamp = now();
    const closedAt = status === 'closed' ? timestamp : null;

    query(
      this.sql,
      /* sql */ `
        UPDATE ${rig_beads}
        SET ${rig_beads.columns.status} = ?,
            ${rig_beads.columns.updated_at} = ?,
            ${rig_beads.columns.closed_at} = COALESCE(?, ${rig_beads.columns.closed_at})
        WHERE ${rig_beads.columns.id} = ?
      `,
      [status, timestamp, closedAt, beadId]
    );

    this.touchAgent(agentId);

    const eventType: BeadEventType = status === 'closed' ? 'closed' : 'status_changed';
    this.writeBeadEvent({
      beadId,
      agentId,
      eventType,
      oldValue: oldStatus,
      newValue: status,
    });

    const bead = this.getBead(beadId);
    if (!bead) throw new Error(`Bead ${beadId} not found`);

    // Notify Town DO if this bead belongs to a convoy and was just closed
    if (status === 'closed' && bead.convoy_id) {
      const townId = await this.getTownId();
      if (townId) {
        try {
          const townDO = getTownDOStub(this.env, townId);
          await townDO.onBeadClosed({ convoyId: bead.convoy_id, beadId });
        } catch (err) {
          console.warn(`${RIG_LOG} updateBeadStatus: failed to notify TownDO of bead close:`, err);
        }
      }
    }

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
        UPDATE ${rig_agents}
        SET ${rig_agents.columns.current_hook_bead_id} = NULL,
            ${rig_agents.columns.status} = 'idle'
        WHERE ${rig_agents.columns.current_hook_bead_id} = ?
      `,
      [beadId]
    );
    query(this.sql, /* sql */ `DELETE FROM ${rig_beads} WHERE ${rig_beads.columns.id} = ?`, [
      beadId,
    ]);
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
        INSERT INTO ${rig_agents} (
          ${rig_agents.columns.id},
          ${rig_agents.columns.role},
          ${rig_agents.columns.name},
          ${rig_agents.columns.identity},
          ${rig_agents.columns.status},
          ${rig_agents.columns.created_at},
          ${rig_agents.columns.last_activity_at}
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
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${rig_agents} WHERE ${rig_agents.columns.id} = ?`,
        [agentId]
      ),
    ];
    if (rows.length === 0) return null;
    return RigAgentRecord.parse(rows[0]);
  }

  async getAgentByIdentity(identity: string): Promise<Agent | null> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${rig_agents} WHERE ${rig_agents.columns.identity} = ?`,
        [identity]
      ),
    ];
    if (rows.length === 0) return null;
    return RigAgentRecord.parse(rows[0]);
  }

  async listAgents(filter?: AgentFilter): Promise<Agent[]> {
    await this.ensureInitialized();

    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${rig_agents}
          WHERE (? IS NULL OR ${rig_agents.columns.role} = ?)
            AND (? IS NULL OR ${rig_agents.columns.status} = ?)
        `,
        [filter?.role ?? null, filter?.role ?? null, filter?.status ?? null, filter?.status ?? null]
      ),
    ];
    return RigAgentRecord.array().parse(rows);
  }

  async updateAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${rig_agents}
        SET ${rig_agents.columns.status} = ?,
            ${rig_agents.columns.last_activity_at} = ?
        WHERE ${rig_agents.columns.id} = ?
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
        UPDATE ${rig_beads}
        SET ${rig_beads.columns.assignee_agent_id} = NULL
        WHERE ${rig_beads.columns.assignee_agent_id} = ?
      `,
      [agentId]
    );
    // Delete mail for this agent
    query(
      this.sql,
      /* sql */ `
        DELETE FROM ${rig_mail}
        WHERE ${rig_mail.columns.to_agent_id} = ? OR ${rig_mail.columns.from_agent_id} = ?
      `,
      [agentId, agentId]
    );
    query(this.sql, /* sql */ `DELETE FROM ${rig_agents} WHERE ${rig_agents.columns.id} = ?`, [
      agentId,
    ]);
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
        UPDATE ${rig_agents}
        SET ${rig_agents.columns.current_hook_bead_id} = ?,
            ${rig_agents.columns.dispatch_attempts} = 0,
            ${rig_agents.columns.last_activity_at} = ?
        WHERE ${rig_agents.columns.id} = ?
      `,
      [beadId, now(), agentId]
    );

    query(
      this.sql,
      /* sql */ `
        UPDATE ${rig_beads}
        SET ${rig_beads.columns.status} = 'in_progress',
            ${rig_beads.columns.assignee_agent_id} = ?,
            ${rig_beads.columns.updated_at} = ?
        WHERE ${rig_beads.columns.id} = ?
      `,
      [agentId, now(), beadId]
    );

    this.writeBeadEvent({
      beadId,
      agentId,
      eventType: 'hooked',
      newValue: agentId,
      metadata: { agent_name: agent.name, agent_role: agent.role },
    });

    console.log(
      `${RIG_LOG} hookBead: bead ${beadId} now in_progress, agent ${agentId} hooked. Arming alarm.`
    );
    await this.armAlarmIfNeeded();
  }

  async unhookBead(agentId: string): Promise<void> {
    await this.ensureInitialized();
    // Read agent to get bead_id before unhooking
    const agent = this.getAgent(agentId);
    const beadId = agent?.current_hook_bead_id;

    query(
      this.sql,
      /* sql */ `
        UPDATE ${rig_agents}
        SET ${rig_agents.columns.current_hook_bead_id} = NULL,
            ${rig_agents.columns.status} = 'idle',
            ${rig_agents.columns.last_activity_at} = ?
        WHERE ${rig_agents.columns.id} = ?
      `,
      [now(), agentId]
    );

    if (beadId) {
      this.writeBeadEvent({
        beadId,
        agentId,
        eventType: 'unhooked',
        oldValue: agentId,
      });
    }
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
        INSERT INTO ${rig_agent_events} (
          ${rig_agent_events.columns.agent_id},
          ${rig_agent_events.columns.event_type},
          ${rig_agent_events.columns.data},
          ${rig_agent_events.columns.created_at}
        ) VALUES (?, ?, ?, ?)`,
      [agentId, eventType, dataJson, timestamp]
    );

    // Prune old events beyond the cap
    query(
      this.sql,
      /* sql */ `
        DELETE FROM ${rig_agent_events}
        WHERE ${rig_agent_events.agent_id} = ?
          AND ${rig_agent_events.id} NOT IN (
            SELECT ${rig_agent_events.id} FROM ${rig_agent_events}
            WHERE ${rig_agent_events.agent_id} = ?
            ORDER BY ${rig_agent_events.id} DESC
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
  ): Promise<RigAgentEventRecord[]> {
    await this.ensureInitialized();

    const rows = query(
      this.sql,
      /* sql */ `
        SELECT ${rig_agent_events.id}, ${rig_agent_events.agent_id}, ${rig_agent_events.event_type},
               ${rig_agent_events.data}, ${rig_agent_events.created_at}
        FROM ${rig_agent_events}
        WHERE ${rig_agent_events.agent_id} = ?
          AND (? IS NULL OR ${rig_agent_events.id} > ?)
        ORDER BY ${rig_agent_events.id} ASC
        LIMIT ?`,
      [agentId, afterId ?? null, afterId ?? null, limit]
    );

    return RigAgentEventRecord.array().parse(rows);
  }

  // ── Mail ───────────────────────────────────────────────────────────────

  async sendMail(input: SendMailInput): Promise<void> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${rig_mail} (
          ${rig_mail.columns.id},
          ${rig_mail.columns.from_agent_id},
          ${rig_mail.columns.to_agent_id},
          ${rig_mail.columns.subject},
          ${rig_mail.columns.body},
          ${rig_mail.columns.created_at}
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
          SELECT * FROM ${rig_mail}
          WHERE ${rig_mail.columns.to_agent_id} = ?
            AND ${rig_mail.columns.delivered} = 0
          ORDER BY ${rig_mail.columns.created_at} ASC
        `,
        [agentId]
      ),
    ];

    // Mark as delivered
    if (rows.length > 0) {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${rig_mail}
          SET ${rig_mail.columns.delivered} = 1,
              ${rig_mail.columns.delivered_at} = ?
          WHERE ${rig_mail.columns.to_agent_id} = ?
            AND ${rig_mail.columns.delivered} = 0
        `,
        [timestamp, agentId]
      );
    }

    this.touchAgent(agentId);
    return RigMailRecord.array().parse(rows);
  }

  // ── Review Queue ───────────────────────────────────────────────────────

  async submitToReviewQueue(input: ReviewQueueInput): Promise<void> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${rig_review_queue} (
          ${rig_review_queue.columns.id},
          ${rig_review_queue.columns.agent_id},
          ${rig_review_queue.columns.bead_id},
          ${rig_review_queue.columns.branch},
          ${rig_review_queue.columns.pr_url},
          ${rig_review_queue.columns.summary},
          ${rig_review_queue.columns.created_at}
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

    this.writeBeadEvent({
      beadId: input.bead_id,
      agentId: input.agent_id,
      eventType: 'review_submitted',
      newValue: input.branch,
      metadata: { pr_url: input.pr_url, summary: input.summary },
    });
  }

  async popReviewQueue(): Promise<ReviewQueueEntry | null> {
    await this.ensureInitialized();

    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${rig_review_queue}
          WHERE ${rig_review_queue.columns.status} = 'pending'
          ORDER BY ${rig_review_queue.columns.created_at} ASC
          LIMIT 1
        `,
        []
      ),
    ];
    if (rows.length === 0) return null;

    const entry = RigReviewQueueRecord.parse(rows[0]);

    query(
      this.sql,
      /* sql */ `
        UPDATE ${rig_review_queue}
        SET ${rig_review_queue.columns.status} = 'running',
            ${rig_review_queue.columns.processed_at} = ?
        WHERE ${rig_review_queue.columns.id} = ?
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
        UPDATE ${rig_review_queue}
        SET ${rig_review_queue.columns.status} = ?,
            ${rig_review_queue.columns.processed_at} = ?
        WHERE ${rig_review_queue.columns.id} = ?
      `,
      [status, now(), entryId]
    );
  }

  /**
   * Called by the container's merge callback to report the result of a merge.
   * On 'merged': marks the review entry as merged and closes the associated bead.
   * On 'conflict': marks as failed and creates an escalation bead with conflict details.
   */
  async completeReviewWithResult(input: {
    entry_id: string;
    status: 'merged' | 'conflict';
    message: string;
    commit_sha?: string;
  }): Promise<void> {
    await this.ensureInitialized();

    const reviewStatus = input.status === 'merged' ? 'merged' : 'failed';
    await this.completeReview(input.entry_id, reviewStatus);

    // Look up the review entry to get the bead_id
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${rig_review_queue}
          WHERE ${rig_review_queue.columns.id} = ?
        `,
        [input.entry_id]
      ),
    ];

    if (rows.length === 0) {
      console.warn(`${RIG_LOG} completeReviewWithResult: entry ${input.entry_id} not found`);
      return;
    }

    const entry = RigReviewQueueRecord.parse(rows[0]);

    if (input.status === 'merged') {
      // Read the bead's current status before closing it
      const beadBefore = this.getBead(entry.bead_id);
      const oldStatus = beadBefore?.status ?? null;

      // Close the bead
      const timestamp = now();
      query(
        this.sql,
        /* sql */ `
          UPDATE ${rig_beads}
          SET ${rig_beads.columns.status} = 'closed',
              ${rig_beads.columns.updated_at} = ?,
              ${rig_beads.columns.closed_at} = ?
          WHERE ${rig_beads.columns.id} = ?
        `,
        [timestamp, timestamp, entry.bead_id]
      );

      this.writeBeadEvent({
        beadId: entry.bead_id,
        agentId: entry.agent_id,
        eventType: 'review_completed',
        oldValue: oldStatus,
        newValue: 'merged',
        metadata: { commit_sha: input.commit_sha, branch: entry.branch },
      });

      console.log(
        `${RIG_LOG} completeReviewWithResult: bead ${entry.bead_id} closed after merge (commit ${input.commit_sha ?? 'unknown'})`
      );
    } else {
      // Conflict — create an escalation bead (createBead writes its own 'created' event)
      await this.createBead({
        type: 'escalation',
        title: `Merge conflict: ${entry.branch}`,
        body: `Automatic merge of branch \`${entry.branch}\` failed.\n\n${input.message}`,
        priority: 'high',
        metadata: {
          source_bead_id: entry.bead_id,
          source_branch: entry.branch,
          agent_id: entry.agent_id,
        },
      });

      this.writeBeadEvent({
        beadId: entry.bead_id,
        agentId: entry.agent_id,
        eventType: 'escalated',
        newValue: input.message,
        metadata: { branch: entry.branch },
      });

      console.log(
        `${RIG_LOG} completeReviewWithResult: merge conflict for bead ${entry.bead_id}, escalation bead created`
      );
    }
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
          SELECT * FROM ${rig_mail}
          WHERE ${rig_mail.columns.to_agent_id} = ?
            AND ${rig_mail.columns.delivered} = 0
          ORDER BY ${rig_mail.columns.created_at} ASC
        `,
        [agentId]
      ),
    ];

    const openBeadRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${rig_beads}
          WHERE ${rig_beads.columns.assignee_agent_id} = ?
            AND ${rig_beads.columns.status} != 'closed'
          ORDER BY ${rig_beads.columns.created_at} DESC
        `,
        [agentId]
      ),
    ];

    this.touchAgent(agentId);

    return {
      agent,
      hooked_bead,
      undelivered_mail: RigMailRecord.array().parse(undeliveredRows),
      open_beads: RigBeadRecord.array().parse(openBeadRows),
    };
  }

  // ── Checkpoint ─────────────────────────────────────────────────────────

  async writeCheckpoint(agentId: string, data: unknown): Promise<void> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${rig_agents}
        SET ${rig_agents.columns.checkpoint} = ?,
            ${rig_agents.columns.last_activity_at} = ?
        WHERE ${rig_agents.columns.id} = ?
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
      // Read previous status before mutating
      const beadBefore = this.getBead(beadId);
      const oldStatus = beadBefore?.status ?? null;

      const beadStatus = input.status === 'completed' ? 'closed' : 'failed';
      console.log(
        `${RIG_LOG} agentCompleted: agent ${agentId} ${input.status}, transitioning bead ${beadId} to '${beadStatus}'`
      );
      const timestamp = now();
      const closedAt = beadStatus === 'closed' ? timestamp : null;
      query(
        this.sql,
        /* sql */ `
          UPDATE ${rig_beads}
          SET ${rig_beads.columns.status} = ?,
              ${rig_beads.columns.updated_at} = ?,
              ${rig_beads.columns.closed_at} = COALESCE(?, ${rig_beads.columns.closed_at})
          WHERE ${rig_beads.columns.id} = ?
        `,
        [beadStatus, timestamp, closedAt, beadId]
      );
      this.writeBeadEvent({
        beadId,
        agentId,
        eventType: input.status === 'completed' ? 'closed' : 'status_changed',
        oldValue: oldStatus,
        newValue: beadStatus,
        metadata: { reason: input.reason },
      });
    } else {
      console.log(`${RIG_LOG} agentCompleted: agent ${agentId} ${input.status} but no hooked bead`);
    }

    // Unhook and set to idle
    await this.unhookBead(agentId);
    await this.armAlarmIfNeeded();
  }

  // ── Molecules ──────────────────────────────────────────────────────────

  /** Formula step definition for molecules. */
  private static readonly FormulaSchema = z.object({
    steps: z
      .array(
        z.object({
          title: z.string(),
          instructions: z.string(),
        })
      )
      .min(1),
  });

  async createMolecule(
    beadId: string,
    formula: { steps: Array<{ title: string; instructions: string }> }
  ): Promise<RigMoleculeRecord> {
    await this.ensureInitialized();
    const parsed = RigDO.FormulaSchema.parse(formula);

    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${rig_molecules} (
          ${rig_molecules.columns.id},
          ${rig_molecules.columns.bead_id},
          ${rig_molecules.columns.formula},
          ${rig_molecules.columns.current_step},
          ${rig_molecules.columns.status},
          ${rig_molecules.columns.created_at},
          ${rig_molecules.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, beadId, JSON.stringify(parsed), 0, 'active', timestamp, timestamp]
    );

    // Link molecule to bead
    query(
      this.sql,
      /* sql */ `
        UPDATE ${rig_beads}
        SET ${rig_beads.columns.molecule_id} = ?
        WHERE ${rig_beads.columns.id} = ?
      `,
      [id, beadId]
    );

    const mol = this.getMolecule(id);
    if (!mol) throw new Error('Failed to create molecule');
    console.log(
      `${RIG_LOG} createMolecule: id=${id} beadId=${beadId} steps=${parsed.steps.length}`
    );
    return mol;
  }

  async getMoleculeAsync(moleculeId: string): Promise<RigMoleculeRecord | null> {
    await this.ensureInitialized();
    return this.getMolecule(moleculeId);
  }

  private getMolecule(moleculeId: string): RigMoleculeRecord | null {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${rig_molecules} WHERE ${rig_molecules.columns.id} = ?`,
        [moleculeId]
      ),
    ];
    if (rows.length === 0) return null;
    return RigMoleculeRecord.parse(rows[0]);
  }

  async getMoleculeForBead(beadId: string): Promise<RigMoleculeRecord | null> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${rig_molecules} WHERE ${rig_molecules.columns.bead_id} = ?`,
        [beadId]
      ),
    ];
    if (rows.length === 0) return null;
    return RigMoleculeRecord.parse(rows[0]);
  }

  /**
   * Get the current molecule step for an agent's hooked bead.
   * Returns the step info or null if no molecule is attached.
   */
  async getMoleculeCurrentStep(agentId: string): Promise<{
    moleculeId: string;
    currentStep: number;
    totalSteps: number;
    step: { title: string; instructions: string };
    status: string;
  } | null> {
    await this.ensureInitialized();
    const agent = this.getAgent(agentId);
    if (!agent?.current_hook_bead_id) return null;

    const mol = await this.getMoleculeForBead(agent.current_hook_bead_id);
    if (!mol) return null;

    const formula = RigDO.FormulaSchema.parse(mol.formula);
    if (mol.current_step >= formula.steps.length) return null;

    return {
      moleculeId: mol.id,
      currentStep: mol.current_step,
      totalSteps: formula.steps.length,
      step: formula.steps[mol.current_step],
      status: mol.status,
    };
  }

  /**
   * Advance the molecule to the next step. If the final step is completed,
   * marks the molecule as completed and triggers the agent done flow.
   */
  async advanceMoleculeStep(
    agentId: string,
    summary: string
  ): Promise<{
    moleculeId: string;
    previousStep: number;
    currentStep: number;
    totalSteps: number;
    completed: boolean;
  }> {
    await this.ensureInitialized();
    const agent = this.getAgent(agentId);
    if (!agent?.current_hook_bead_id) {
      throw new Error('Agent has no hooked bead');
    }

    const mol = await this.getMoleculeForBead(agent.current_hook_bead_id);
    if (!mol) throw new Error('No molecule attached to hooked bead');
    if (mol.status !== 'active') throw new Error(`Molecule is ${mol.status}, cannot advance`);

    const formula = RigDO.FormulaSchema.parse(mol.formula);
    const previousStep = mol.current_step;
    const nextStep = previousStep + 1;
    const completed = nextStep >= formula.steps.length;

    // Record step completion as a bead event
    this.writeBeadEvent({
      beadId: agent.current_hook_bead_id,
      agentId,
      eventType: 'status_changed',
      metadata: {
        event: 'molecule_step_completed',
        step: previousStep,
        step_title: formula.steps[previousStep].title,
        summary,
      },
    });

    if (completed) {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${rig_molecules}
          SET ${rig_molecules.columns.current_step} = ?,
              ${rig_molecules.columns.status} = 'completed',
              ${rig_molecules.columns.updated_at} = ?
          WHERE ${rig_molecules.columns.id} = ?
        `,
        [nextStep, now(), mol.id]
      );
      console.log(`${RIG_LOG} advanceMoleculeStep: molecule ${mol.id} completed`);
    } else {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${rig_molecules}
          SET ${rig_molecules.columns.current_step} = ?,
              ${rig_molecules.columns.updated_at} = ?
          WHERE ${rig_molecules.columns.id} = ?
        `,
        [nextStep, now(), mol.id]
      );
      console.log(
        `${RIG_LOG} advanceMoleculeStep: molecule ${mol.id} advanced to step ${nextStep}/${formula.steps.length}`
      );
    }

    return {
      moleculeId: mol.id,
      previousStep,
      currentStep: nextStep,
      totalSteps: formula.steps.length,
      completed,
    };
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
          SELECT * FROM ${rig_agents}
          WHERE ${rig_agents.columns.role} = ?
          ORDER BY CASE WHEN ${rig_agents.columns.status} = 'idle' THEN 0 ELSE 1 END,
                   ${rig_agents.columns.last_activity_at} ASC
          LIMIT ?
        `,
        [role, 1]
      ),
    ];

    if (existing.length > 0) {
      const agent = RigAgentRecord.parse(existing[0]);
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

    // For polecats: enforce concurrency cap before creating a new one
    if (role === 'polecat') {
      const townConfig = await this.fetchTownConfig();
      const maxPolecats = townConfig?.max_polecats_per_rig ?? DEFAULT_MAX_POLECATS;
      const polecatCount = this.countAgentsByRole('polecat');
      if (polecatCount >= maxPolecats) {
        console.error(
          `${RIG_LOG} getOrCreateAgent: polecat cap reached (${polecatCount}/${maxPolecats}), cannot create new polecat`
        );
        throw new Error(
          `Maximum polecats per rig reached (${maxPolecats}). Wait for a polecat to finish or increase the limit in town settings.`
        );
      }
    }

    // Allocate a name from the pool (polecats) or use role-based naming
    const name = role === 'polecat' ? this.allocatePolecatName() : role;
    const identity = `${role}/${name}`;

    console.log(`${RIG_LOG} getOrCreateAgent: creating new agent for role=${role} name=${name}`);
    return this.registerAgent({ role, name, identity });
  }

  /** Count active agents of a given role (excludes dead/failed). */
  private countAgentsByRole(role: string): number {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(*) as cnt FROM ${rig_agents}
          WHERE ${rig_agents.columns.role} = ?
            AND ${rig_agents.columns.status} NOT IN ('dead', 'failed')
        `,
        [role]
      ),
    ];
    return Number(rows[0]?.cnt ?? 0);
  }

  /** Pick the next available name from the polecat name pool. */
  private allocatePolecatName(): string {
    const usedNames = new Set(
      [
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${rig_agents.columns.name} FROM ${rig_agents}
            WHERE ${rig_agents.columns.role} = 'polecat'
          `,
          []
        ),
      ].map(row => {
        const parsed = RigAgentRecord.pick({ name: true }).parse(row);
        return parsed.name;
      })
    );

    for (const name of POLECAT_NAMES) {
      if (!usedNames.has(name)) return name;
    }

    // Pool exhausted — fall back to numbered name
    let n = POLECAT_NAMES.length + 1;
    while (usedNames.has(`Polecat-${n}`)) n++;
    return `Polecat-${n}`;
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
          SELECT COUNT(*) as cnt FROM ${rig_agents}
          WHERE ${rig_agents.columns.status} IN ('working', 'blocked')
        `,
        []
      ),
    ];

    const pendingBeadRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(*) as cnt FROM ${rig_beads}
          WHERE ${rig_beads.columns.status} = 'in_progress'
        `,
        []
      ),
    ];

    const pendingReviewRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(*) as cnt FROM ${rig_review_queue}
          WHERE ${rig_review_queue.columns.status} IN ('pending', 'running')
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
          SELECT * FROM ${rig_agents}
          WHERE ${rig_agents.columns.status} = 'idle'
            AND ${rig_agents.columns.current_hook_bead_id} IS NOT NULL
        `,
        []
      ),
    ];
    const pendingAgents = RigAgentRecord.array().parse(rows);
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
            UPDATE ${rig_beads}
            SET ${rig_beads.columns.status} = 'failed',
                ${rig_beads.columns.updated_at} = ?
            WHERE ${rig_beads.columns.id} = ?
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
          UPDATE ${rig_agents}
          SET ${rig_agents.columns.dispatch_attempts} = ?
          WHERE ${rig_agents.columns.id} = ?
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
            UPDATE ${rig_agents}
            SET ${rig_agents.columns.status} = 'working',
                ${rig_agents.columns.dispatch_attempts} = 0,
                ${rig_agents.columns.last_activity_at} = ?
            WHERE ${rig_agents.columns.id} = ?
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

  /** Build the system prompt for an agent given its role and context. */
  private static systemPromptForRole(params: {
    role: string;
    identity: string;
    agentName: string;
    rigId: string;
    townId: string;
  }): string {
    switch (params.role) {
      case 'polecat':
        return buildPolecatSystemPrompt({
          agentName: params.agentName,
          rigId: params.rigId,
          townId: params.townId,
          identity: params.identity,
        });
      case 'mayor':
        return buildMayorSystemPrompt({
          identity: params.identity,
          townId: params.townId,
        });
      default: {
        // Fallback for roles without a dedicated prompt builder
        const base = `You are ${params.identity}, a Gastown ${params.role} agent. Follow all instructions in the GASTOWN CONTEXT injected into this session.`;
        switch (params.role) {
          case 'refinery':
            return `${base} You review code quality and merge PRs. Check for correctness, style, and test coverage.`;
          case 'witness':
            return `${base} You monitor agent health and report anomalies.`;
          default:
            return base;
        }
      }
    }
  }

  /** Default model for agent roles. */
  private static modelForRole(role: string): string {
    switch (role) {
      case 'polecat':
        return 'anthropic/claude-sonnet-4.6';
      case 'refinery':
        return 'anthropic/claude-sonnet-4.6';
      case 'mayor':
        return 'anthropic/claude-sonnet-4.6';
      default:
        return 'anthropic/claude-sonnet-4.6';
    }
  }

  /** Generate a branch name for an agent working on a specific bead. */
  private static branchForAgent(name: string, beadId?: string): string {
    // Sanitize agent name → branch-safe slug
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-');
    // Include bead ID prefix for branch isolation between assignments
    const beadSuffix = beadId ? `/${beadId.slice(0, 8)}` : '';
    return `gt/${slug}${beadSuffix}`;
  }

  /**
   * Fetch TownConfig from the Town DO for this rig's town.
   * Returns null if no town is configured.
   */
  private async fetchTownConfig(): Promise<TownConfig | null> {
    const townId = await this.getTownId();
    if (!townId) return null;
    try {
      const townDO = getTownDOStub(this.env, townId);
      return await townDO.getTownConfig();
    } catch (err) {
      console.warn(`${RIG_LOG} fetchTownConfig: failed to fetch config from TownDO:`, err);
      return null;
    }
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
      /** Override the default system prompt for this role (e.g., refinery with gate-specific instructions) */
      systemPromptOverride?: string;
    }
  ): Promise<boolean> {
    console.log(
      `${RIG_LOG} startAgentInContainer: agentId=${params.agentId} role=${params.role} name=${params.agentName} beadId=${params.beadId} townId=${config.townId}`
    );
    try {
      const token = await this.mintAgentToken(params.agentId, config);
      console.log(`${RIG_LOG} startAgentInContainer: JWT minted=${!!token}`);

      // 1. Start with town-level env vars (config inheritance: town → system → agent)
      const townConfig = await this.fetchTownConfig();
      const envVars: Record<string, string> = { ...(townConfig?.env_vars ?? {}) };

      // 2. Map git_auth tokens to env vars
      if (townConfig?.git_auth?.github_token) {
        envVars.GIT_TOKEN = townConfig.git_auth.github_token;
      }
      if (townConfig?.git_auth?.gitlab_token) {
        envVars.GITLAB_TOKEN = townConfig.git_auth.gitlab_token;
      }
      if (townConfig?.git_auth?.gitlab_instance_url) {
        envVars.GITLAB_INSTANCE_URL = townConfig.git_auth.gitlab_instance_url;
      }

      // 3. System defaults (overwrite user-provided values for reserved keys)
      if (token) {
        envVars.GASTOWN_SESSION_TOKEN = token;
      }

      // Pass LLM gateway credentials so kilo serve can route inference calls
      // (KILO_API_URL and KILO_OPENROUTER_BASE are set at container level via TownContainerDO.envVars)
      if (config.kilocodeToken) {
        envVars.KILOCODE_TOKEN = config.kilocodeToken;
      }

      const rigId = this.ctx.id.name ?? config.rigId ?? '';
      console.log(
        `${RIG_LOG} startAgentInContainer: rigId=${rigId} gitUrl=${config.gitUrl} branch=${RigDO.branchForAgent(params.agentName, params.beadId)}`
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
          systemPrompt:
            params.systemPromptOverride ??
            RigDO.systemPromptForRole({
              role: params.role,
              identity: params.identity,
              agentName: params.agentName,
              rigId,
              townId: config.townId,
            }),
          gitUrl: config.gitUrl,
          branch: RigDO.branchForAgent(params.agentName, params.beadId),
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

    // If refinery gates are configured, dispatch an AI refinery agent.
    // Otherwise, use the deterministic merge fallback.
    const townConfig = await this.fetchTownConfig();
    const gates = townConfig?.refinery?.gates ?? [];

    if (gates.length > 0) {
      await this.startRefineryAgent(config, entry, gates);
    } else {
      await this.startMergeInContainer(config, entry);
    }
    return true;
  }

  /**
   * Dispatch an AI refinery agent to review and merge a polecat's branch.
   * The refinery runs quality gates, reviews the diff, and decides
   * whether to merge or request rework.
   */
  private async startRefineryAgent(
    config: RigConfig,
    entry: ReviewQueueEntry,
    gates: string[]
  ): Promise<void> {
    const refineryAgent = await this.getOrCreateAgent('refinery');
    const rigId = this.ctx.id.name ?? config.rigId ?? '';

    const systemPrompt = buildRefinerySystemPrompt({
      identity: refineryAgent.identity,
      rigId,
      townId: config.townId,
      gates,
      branch: entry.branch,
      targetBranch: config.defaultBranch,
      polecatAgentId: entry.agent_id,
    });

    const prompt = `Review and process merge request for branch "${entry.branch}" into "${config.defaultBranch}".${entry.summary ? `\n\nPolecat summary: ${entry.summary}` : ''}`;

    // Hook the review's bead to the refinery so it shows in the dashboard
    await this.hookBead(refineryAgent.id, entry.bead_id);

    const started = await this.startAgentInContainer(config, {
      agentId: refineryAgent.id,
      agentName: refineryAgent.name,
      role: 'refinery',
      identity: refineryAgent.identity,
      beadId: entry.bead_id,
      beadTitle: prompt,
      beadBody: `Quality gates: ${gates.join(', ')}\nBranch: ${entry.branch}\nTarget: ${config.defaultBranch}`,
      checkpoint: null,
      systemPromptOverride: systemPrompt,
    });

    if (!started) {
      console.error(
        `${RIG_LOG} startRefineryAgent: failed to start refinery for entry ${entry.id}`
      );
      await this.unhookBead(refineryAgent.id);
      // Fall back to deterministic merge
      await this.startMergeInContainer(config, entry);
    }
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
        UPDATE ${rig_review_queue}
        SET ${rig_review_queue.columns.status} = 'pending',
            ${rig_review_queue.columns.processed_at} = NULL
        WHERE ${rig_review_queue.columns.status} = 'running'
          AND ${rig_review_queue.columns.processed_at} < ?
      `,
      [timeout]
    );
  }

  /**
   * Signal the container to run a deterministic merge for a review queue entry.
   * The container runs the merge asynchronously and calls back to
   * `completeReview` when done.
   */
  private async startMergeInContainer(config: RigConfig, entry: ReviewQueueEntry): Promise<void> {
    try {
      const token = await this.mintAgentToken(entry.agent_id, config);
      const rigId = this.ctx.id.name ?? config.rigId;
      if (!rigId) {
        console.error(
          `${RIG_LOG} startMergeInContainer: no rigId available, cannot dispatch merge for entry ${entry.id}`
        );
        await this.completeReview(entry.id, 'failed');
        return;
      }

      // Start with town-level env vars for git auth tokens
      const townConfig = await this.fetchTownConfig();
      const envVars: Record<string, string> = { ...(townConfig?.env_vars ?? {}) };

      // Map git_auth tokens
      if (townConfig?.git_auth?.github_token) {
        envVars.GIT_TOKEN = townConfig.git_auth.github_token;
      }
      if (townConfig?.git_auth?.gitlab_token) {
        envVars.GITLAB_TOKEN = townConfig.git_auth.gitlab_token;
      }
      if (townConfig?.git_auth?.gitlab_instance_url) {
        envVars.GITLAB_INSTANCE_URL = townConfig.git_auth.gitlab_instance_url;
      }

      if (token) {
        envVars.GASTOWN_SESSION_TOKEN = token;
      }
      if (this.env.GASTOWN_API_URL) {
        envVars.GASTOWN_API_URL = this.env.GASTOWN_API_URL;
      }
      // KILO_API_URL and KILO_OPENROUTER_BASE are set at container level via TownContainerDO.envVars
      if (config.kilocodeToken) {
        envVars.KILOCODE_TOKEN = config.kilocodeToken;
      }

      const container = getTownContainerStub(this.env, config.townId);
      const response = await container.fetch('http://container/git/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rigId,
          branch: entry.branch,
          targetBranch: config.defaultBranch,
          gitUrl: config.gitUrl,
          entryId: entry.id,
          beadId: entry.bead_id,
          agentId: entry.agent_id,
          envVars,
        }),
      });

      if (!response.ok) {
        console.error(
          `${RIG_LOG} startMergeInContainer: merge request failed for entry ${entry.id}: ${response.status}`
        );
        await this.completeReview(entry.id, 'failed');
      }
      // On success, the container will call back to completeReview when merge finishes
    } catch (err) {
      console.error(
        `${RIG_LOG} startMergeInContainer: failed to start merge for entry ${entry.id}:`,
        err
      );
      await this.completeReview(entry.id, 'failed');
    }
  }

  // ── Health (called by alarm) ──────────────────────────────────────────

  async witnessPatrol(): Promise<PatrolResult> {
    await this.ensureInitialized();
    console.log(`${RIG_LOG} witnessPatrol: starting`);

    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    const guppThreshold = new Date(Date.now() - GUPP_THRESHOLD_MS).toISOString();

    const AgentId = RigAgentRecord.pick({ id: true });
    const BeadId = RigBeadRecord.pick({ id: true });

    // Detect dead agents
    const deadAgents = AgentId.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${rig_agents.columns.id} FROM ${rig_agents}
          WHERE ${rig_agents.columns.status} = 'dead'
        `,
        []
      ),
    ]);

    // Detect stale agents (working but no activity for STALE_THRESHOLD_MS)
    const staleAgents = AgentId.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${rig_agents.columns.id} FROM ${rig_agents}
          WHERE ${rig_agents.columns.status} = 'working'
            AND ${rig_agents.columns.last_activity_at} < ?
        `,
        [staleThreshold]
      ),
    ]);

    // Detect orphaned beads (in_progress with no live assignee)
    const orphanedBeads = BeadId.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${rig_beads.columns.id} FROM ${rig_beads}
          WHERE ${rig_beads.columns.status} = 'in_progress'
            AND (
              ${rig_beads.columns.assignee_agent_id} IS NULL
              OR ${rig_beads.columns.assignee_agent_id} NOT IN (
                SELECT ${rig_agents.columns.id} FROM ${rig_agents}
                WHERE ${rig_agents.columns.status} != 'dead'
              )
            )
        `,
        []
      ),
    ]);

    // Check container process health for working/blocked agents
    const townId = await this.getTownId();
    if (townId) {
      const WorkingAgent = RigAgentRecord.pick({
        id: true,
        current_hook_bead_id: true,
        last_activity_at: true,
      });
      const workingAgents = WorkingAgent.array().parse([
        ...query(
          this.sql,
          /* sql */ `
             SELECT ${rig_agents.columns.id},
                    ${rig_agents.columns.current_hook_bead_id},
                    ${rig_agents.columns.last_activity_at}
             FROM ${rig_agents}
             WHERE ${rig_agents.columns.status} IN ('working', 'blocked')
           `,
          []
        ),
      ]);

      const MailId = RigMailRecord.pick({ id: true });

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
              UPDATE ${rig_agents}
              SET ${rig_agents.columns.status} = 'idle',
                  ${rig_agents.columns.last_activity_at} = ?
              WHERE ${rig_agents.columns.id} = ?
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
                SELECT ${rig_mail.columns.id} FROM ${rig_mail}
                WHERE ${rig_mail.columns.to_agent_id} = ?
                  AND ${rig_mail.columns.subject} = 'GUPP_CHECK'
                  AND ${rig_mail.columns.delivered} = 0
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
        UPDATE ${rig_agents}
        SET ${rig_agents.columns.last_activity_at} = ?
        WHERE ${rig_agents.columns.id} = ?
      `,
      [now(), agentId]
    );
  }
}

export function getRigDOStub(env: Env, rigId: string) {
  return env.RIG.get(env.RIG.idFromName(rigId));
}
