import { DurableObject } from 'cloudflare:workers';
import { createTableBeads, getIndexesBeads, beads } from '../db/tables/beads.table';
import { createTableAgents, agents } from '../db/tables/agents.table';
import { createTableMail, getIndexesMail, mail } from '../db/tables/mail.table';
import { createTableReviewQueue, reviewQueue } from '../db/tables/review-queue.table';
import { createTableMolecules, molecules } from '../db/tables/molecules.table';
import type {
  Bead,
  CreateBeadInput,
  BeadFilter,
  Agent,
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
    this.sql.exec(createTableBeads());
    for (const idx of getIndexesBeads()) {
      this.sql.exec(idx);
    }

    this.sql.exec(createTableAgents());
    this.sql.exec(createTableMail());
    for (const idx of getIndexesMail()) {
      this.sql.exec(idx);
    }

    this.sql.exec(createTableReviewQueue());
    this.sql.exec(createTableMolecules());
  }

  // ── Beads ──────────────────────────────────────────────────────────────

  async createBead(input: CreateBeadInput): Promise<Bead> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();
    const labelsJson = JSON.stringify(input.labels ?? []);
    const metadataJson = JSON.stringify(input.metadata ?? {});

    this.sql.exec(
      `INSERT INTO ${beads} (${beads.columns.id}, ${beads.columns.type}, ${beads.columns.status}, ${beads.columns.title}, ${beads.columns.body}, ${beads.columns.assignee_agent_id}, ${beads.columns.convoy_id}, ${beads.columns.priority}, ${beads.columns.labels}, ${beads.columns.metadata}, ${beads.columns.created_at}, ${beads.columns.updated_at})
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      timestamp
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
    const rows = [...this.sql.exec(`SELECT * FROM ${beads} WHERE ${beads.columns.id} = ?`, beadId)];
    if (rows.length === 0) return null;
    return this.rowToBead(rows[0]);
  }

  async listBeads(filter: BeadFilter): Promise<Bead[]> {
    await this.ensureInitialized();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      conditions.push(`${beads.columns.status} = ?`);
      params.push(filter.status);
    }
    if (filter.type) {
      conditions.push(`${beads.columns.type} = ?`);
      params.push(filter.type);
    }
    if (filter.assignee_agent_id) {
      conditions.push(`${beads.columns.assignee_agent_id} = ?`);
      params.push(filter.assignee_agent_id);
    }
    if (filter.convoy_id) {
      conditions.push(`${beads.columns.convoy_id} = ?`);
      params.push(filter.convoy_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${beads} ${where} ORDER BY ${beads.columns.created_at} DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset
      ),
    ];
    return rows.map(r => this.rowToBead(r));
  }

  async updateBeadStatus(beadId: string, status: string, agentId: string): Promise<Bead> {
    await this.ensureInitialized();
    const timestamp = now();
    const closedAt = status === 'closed' ? timestamp : null;

    this.sql.exec(
      `UPDATE ${beads} SET ${beads.columns.status} = ?, ${beads.columns.updated_at} = ?, ${beads.columns.closed_at} = COALESCE(?, ${beads.columns.closed_at}) WHERE ${beads.columns.id} = ?`,
      status,
      timestamp,
      closedAt,
      beadId
    );

    // Update agent activity
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

    this.sql.exec(
      `INSERT INTO ${agents} (${agents.columns.id}, ${agents.columns.role}, ${agents.columns.name}, ${agents.columns.identity}, ${agents.columns.status}, ${agents.columns.created_at}, ${agents.columns.last_activity_at})
       VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
      id,
      input.role,
      input.name,
      input.identity,
      timestamp,
      timestamp
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
      ...this.sql.exec(`SELECT * FROM ${agents} WHERE ${agents.columns.id} = ?`, agentId),
    ];
    if (rows.length === 0) return null;
    return this.rowToAgent(rows[0]);
  }

  async getAgentByIdentity(identity: string): Promise<Agent | null> {
    await this.ensureInitialized();
    const rows = [
      ...this.sql.exec(`SELECT * FROM ${agents} WHERE ${agents.columns.identity} = ?`, identity),
    ];
    if (rows.length === 0) return null;
    return this.rowToAgent(rows[0]);
  }

  async listAgents(filter?: AgentFilter): Promise<Agent[]> {
    await this.ensureInitialized();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.role) {
      conditions.push(`${agents.columns.role} = ?`);
      params.push(filter.role);
    }
    if (filter?.status) {
      conditions.push(`${agents.columns.status} = ?`);
      params.push(filter.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = [...this.sql.exec(`SELECT * FROM ${agents} ${where}`, ...params)];
    return rows.map(r => this.rowToAgent(r));
  }

  async updateAgentSession(agentId: string, sessionId: string | null): Promise<void> {
    await this.ensureInitialized();
    this.sql.exec(
      `UPDATE ${agents} SET ${agents.columns.cloud_agent_session_id} = ?, ${agents.columns.last_activity_at} = ? WHERE ${agents.columns.id} = ?`,
      sessionId,
      now(),
      agentId
    );
  }

  async updateAgentStatus(agentId: string, status: string): Promise<void> {
    await this.ensureInitialized();
    this.sql.exec(
      `UPDATE ${agents} SET ${agents.columns.status} = ?, ${agents.columns.last_activity_at} = ? WHERE ${agents.columns.id} = ?`,
      status,
      now(),
      agentId
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

    this.sql.exec(
      `UPDATE ${agents} SET ${agents.columns.current_hook_bead_id} = ?, ${agents.columns.status} = 'working', ${agents.columns.last_activity_at} = ? WHERE ${agents.columns.id} = ?`,
      beadId,
      now(),
      agentId
    );

    // Update bead status to in_progress and assign
    this.sql.exec(
      `UPDATE ${beads} SET ${beads.columns.status} = 'in_progress', ${beads.columns.assignee_agent_id} = ?, ${beads.columns.updated_at} = ? WHERE ${beads.columns.id} = ?`,
      agentId,
      now(),
      beadId
    );
  }

  async unhookBead(agentId: string): Promise<void> {
    await this.ensureInitialized();
    this.sql.exec(
      `UPDATE ${agents} SET ${agents.columns.current_hook_bead_id} = NULL, ${agents.columns.status} = 'idle', ${agents.columns.last_activity_at} = ? WHERE ${agents.columns.id} = ?`,
      now(),
      agentId
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

    this.sql.exec(
      `INSERT INTO ${mail} (${mail.columns.id}, ${mail.columns.from_agent_id}, ${mail.columns.to_agent_id}, ${mail.columns.subject}, ${mail.columns.body}, ${mail.columns.created_at})
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.from_agent_id,
      input.to_agent_id,
      input.subject,
      input.body,
      timestamp
    );
  }

  async checkMail(agentId: string): Promise<Mail[]> {
    await this.ensureInitialized();
    const timestamp = now();

    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${mail} WHERE ${mail.columns.to_agent_id} = ? AND ${mail.columns.delivered} = 0 ORDER BY ${mail.columns.created_at} ASC`,
        agentId
      ),
    ];

    // Mark as delivered
    if (rows.length > 0) {
      this.sql.exec(
        `UPDATE ${mail} SET ${mail.columns.delivered} = 1, ${mail.columns.delivered_at} = ? WHERE ${mail.columns.to_agent_id} = ? AND ${mail.columns.delivered} = 0`,
        timestamp,
        agentId
      );
    }

    this.touchAgent(agentId);
    return rows.map(r => this.rowToMail(r));
  }

  // ── Review Queue ───────────────────────────────────────────────────────

  async submitToReviewQueue(input: ReviewQueueInput): Promise<void> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();

    this.sql.exec(
      `INSERT INTO ${reviewQueue} (${reviewQueue.columns.id}, ${reviewQueue.columns.agent_id}, ${reviewQueue.columns.bead_id}, ${reviewQueue.columns.branch}, ${reviewQueue.columns.pr_url}, ${reviewQueue.columns.summary}, ${reviewQueue.columns.created_at})
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.agent_id,
      input.bead_id,
      input.branch,
      input.pr_url ?? null,
      input.summary ?? null,
      timestamp
    );
  }

  async popReviewQueue(): Promise<ReviewQueueEntry | null> {
    await this.ensureInitialized();

    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${reviewQueue} WHERE ${reviewQueue.columns.status} = 'pending' ORDER BY ${reviewQueue.columns.created_at} ASC LIMIT 1`
      ),
    ];
    if (rows.length === 0) return null;

    const entry = this.rowToReviewQueueEntry(rows[0]);

    // Mark as running
    this.sql.exec(
      `UPDATE ${reviewQueue} SET ${reviewQueue.columns.status} = 'running', ${reviewQueue.columns.processed_at} = ? WHERE ${reviewQueue.columns.id} = ?`,
      now(),
      entry.id
    );

    return { ...entry, status: 'running' };
  }

  async completeReview(entryId: string, status: 'merged' | 'failed'): Promise<void> {
    await this.ensureInitialized();
    this.sql.exec(
      `UPDATE ${reviewQueue} SET ${reviewQueue.columns.status} = ?, ${reviewQueue.columns.processed_at} = ? WHERE ${reviewQueue.columns.id} = ?`,
      status,
      now(),
      entryId
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

    // Get undelivered mail (but don't mark as delivered — prime is read-only)
    const undeliveredRows = [
      ...this.sql.exec(
        `SELECT * FROM ${mail} WHERE ${mail.columns.to_agent_id} = ? AND ${mail.columns.delivered} = 0 ORDER BY ${mail.columns.created_at} ASC`,
        agentId
      ),
    ];

    // Get open beads assigned to this agent
    const openBeadRows = [
      ...this.sql.exec(
        `SELECT * FROM ${beads} WHERE ${beads.columns.assignee_agent_id} = ? AND ${beads.columns.status} != 'closed' ORDER BY ${beads.columns.created_at} DESC`,
        agentId
      ),
    ];

    this.touchAgent(agentId);

    return {
      agent,
      hooked_bead,
      undelivered_mail: undeliveredRows.map(r => this.rowToMail(r)),
      open_beads: openBeadRows.map(r => this.rowToBead(r)),
    };
  }

  // ── Checkpoint ─────────────────────────────────────────────────────────

  async writeCheckpoint(agentId: string, data: unknown): Promise<void> {
    await this.ensureInitialized();
    this.sql.exec(
      `UPDATE ${agents} SET ${agents.columns.checkpoint} = ?, ${agents.columns.last_activity_at} = ? WHERE ${agents.columns.id} = ?`,
      JSON.stringify(data),
      now(),
      agentId
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
  }

  // ── Health (called by alarms) ──────────────────────────────────────────

  async witnessPatrol(): Promise<PatrolResult> {
    await this.ensureInitialized();

    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

    // Find dead agents (status = 'dead')
    const deadRows = [
      ...this.sql.exec(
        `SELECT ${agents.columns.id} FROM ${agents} WHERE ${agents.columns.status} = 'dead'`
      ),
    ];

    // Find stale agents (working but no recent activity)
    const staleRows = [
      ...this.sql.exec(
        `SELECT ${agents.columns.id} FROM ${agents} WHERE ${agents.columns.status} = 'working' AND ${agents.columns.last_activity_at} < ?`,
        staleThreshold
      ),
    ];

    // Find orphaned beads (in_progress but assignee is dead or doesn't exist)
    const orphanedRows = [
      ...this.sql.exec(
        `SELECT ${beads.columns.id} FROM ${beads}
         WHERE ${beads.columns.status} = 'in_progress'
         AND (${beads.columns.assignee_agent_id} IS NULL
              OR ${beads.columns.assignee_agent_id} NOT IN (SELECT ${agents.columns.id} FROM ${agents} WHERE ${agents.columns.status} != 'dead'))`
      ),
    ];

    return {
      dead_agents: deadRows.map(r => String(r.id)),
      stale_agents: staleRows.map(r => String(r.id)),
      orphaned_beads: orphanedRows.map(r => String(r.id)),
    };
  }

  // ── Row mappers ────────────────────────────────────────────────────────

  private touchAgent(agentId: string): void {
    this.sql.exec(
      `UPDATE ${agents} SET ${agents.columns.last_activity_at} = ? WHERE ${agents.columns.id} = ?`,
      now(),
      agentId
    );
  }

  private rowToBead(row: Record<string, SqlStorageValue>): Bead {
    return {
      id: String(row.id),
      type: String(row.type) as Bead['type'],
      status: String(row.status) as Bead['status'],
      title: String(row.title),
      body: row.body === null ? null : String(row.body),
      assignee_agent_id: row.assignee_agent_id === null ? null : String(row.assignee_agent_id),
      convoy_id: row.convoy_id === null ? null : String(row.convoy_id),
      molecule_id: row.molecule_id === null ? null : String(row.molecule_id),
      priority: String(row.priority) as Bead['priority'],
      labels: JSON.parse(String(row.labels)) as string[],
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      closed_at: row.closed_at === null ? null : String(row.closed_at),
    };
  }

  private rowToAgent(row: Record<string, SqlStorageValue>): Agent {
    return {
      id: String(row.id),
      role: String(row.role) as Agent['role'],
      name: String(row.name),
      identity: String(row.identity),
      cloud_agent_session_id:
        row.cloud_agent_session_id === null ? null : String(row.cloud_agent_session_id),
      status: String(row.status) as Agent['status'],
      current_hook_bead_id:
        row.current_hook_bead_id === null ? null : String(row.current_hook_bead_id),
      last_activity_at: row.last_activity_at === null ? null : String(row.last_activity_at),
      checkpoint: row.checkpoint === null ? null : JSON.parse(String(row.checkpoint)),
      created_at: String(row.created_at),
    };
  }

  private rowToMail(row: Record<string, SqlStorageValue>): Mail {
    return {
      id: String(row.id),
      from_agent_id: String(row.from_agent_id),
      to_agent_id: String(row.to_agent_id),
      subject: String(row.subject),
      body: String(row.body),
      delivered: Boolean(row.delivered),
      created_at: String(row.created_at),
      delivered_at: row.delivered_at === null ? null : String(row.delivered_at),
    };
  }

  private rowToReviewQueueEntry(row: Record<string, SqlStorageValue>): ReviewQueueEntry {
    return {
      id: String(row.id),
      agent_id: String(row.agent_id),
      bead_id: String(row.bead_id),
      branch: String(row.branch),
      pr_url: row.pr_url === null ? null : String(row.pr_url),
      status: String(row.status) as ReviewQueueEntry['status'],
      summary: row.summary === null ? null : String(row.summary),
      created_at: String(row.created_at),
      processed_at: row.processed_at === null ? null : String(row.processed_at),
    };
  }
}

export function getRigDOStub(env: Env, rigId: string) {
  return env.RIG.get(env.RIG.idFromName(rigId));
}
