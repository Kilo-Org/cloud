/**
 * TownDO — The single source of truth for all control-plane data.
 *
 * After the town-centric refactor (#419), ALL gastown state lives here:
 * rigs, agents, beads, mail, review queues, molecules, bead events,
 * convoys, escalations, and configuration.
 *
 * After the beads-centric refactor (#441), all object types are unified
 * into the beads table with satellite metadata tables. Separate tables
 * for mail, molecules, review queue, convoys, and escalations are eliminated.
 *
 * Agent events (high-volume SSE/streaming data) are delegated to per-agent
 * AgentDOs to stay within the 10GB DO SQLite limit.
 */

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

// Sub-modules (plain functions, not classes — per coding style)
import * as beadOps from './town/beads';
import * as agents from './town/agents';
import * as mail from './town/mail';
import * as reviewQueue from './town/review-queue';
import * as config from './town/config';
import * as rigs from './town/rigs';
import * as dispatch from './town/container-dispatch';
import * as patrol from './town/patrol';
import { GitHubPRStatusSchema, GitLabMRStatusSchema } from '../util/platform-pr.util';

// Table imports for beads-centric operations
import {
  beads,
  BeadRecord,
  AgentBeadRecord,
  EscalationBeadRecord,
  ConvoyBeadRecord,
} from '../db/tables/beads.table';
import { agent_metadata, AgentMetadataRecord } from '../db/tables/agent-metadata.table';
import { review_metadata } from '../db/tables/review-metadata.table';
import { escalation_metadata } from '../db/tables/escalation-metadata.table';
import { convoy_metadata } from '../db/tables/convoy-metadata.table';
import { bead_dependencies } from '../db/tables/bead-dependencies.table';
import { query } from '../util/query.util';
import { getAgentDOStub } from './Agent.do';
import { getTownContainerStub } from './TownContainer.do';

import { BeadPriority } from '../types';
import type {
  TownConfig,
  TownConfigUpdate,
  CreateBeadInput,
  BeadFilter,
  Bead,
  RegisterAgentInput,
  AgentFilter,
  Agent,
  AgentRole,
  SendMailInput,
  Mail,
  ReviewQueueInput,
  ReviewQueueEntry,
  AgentDoneInput,
  PrimeContext,
  Molecule,
  BeadEventRecord,
  MergeStrategy,
} from '../types';

const TOWN_LOG = '[Town.do]';

/** Format a bead_events row into a human-readable message for the status feed. */
function formatEventMessage(row: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? '' : `${v as string}`);
  const eventType = s(row.event_type);
  const beadTitle = row.bead_title ? s(row.bead_title) : null;
  const newValue = row.new_value ? s(row.new_value) : null;
  const agentId = row.agent_id ? s(row.agent_id).slice(0, 8) : null;
  const beadId = row.bead_id ? s(row.bead_id).slice(0, 8) : null;

  const target = beadTitle ? `"${beadTitle}"` : beadId ? `bead ${beadId}…` : 'unknown';
  const actor = agentId ? `agent ${agentId}…` : 'system';

  switch (eventType) {
    case 'status_changed':
      return `${target} → ${newValue ?? '?'} (by ${actor})`;
    case 'assigned':
      return `${target} assigned to ${actor}`;
    case 'pr_created':
      return `PR created for ${target}`;
    case 'pr_merged':
      return `PR merged for ${target}`;
    case 'pr_creation_failed':
      return `PR creation failed for ${target}`;
    case 'escalation_created':
      return `Escalation created: ${target}`;
    case 'agent_status':
      return `${actor}: ${newValue ?? 'status update'}`;
    default:
      return `${eventType}: ${target}`;
  }
}

// Alarm intervals
const ACTIVE_ALARM_INTERVAL_MS = 5_000; // 5s when agents are active
const IDLE_ALARM_INTERVAL_MS = 1 * 60_000; // 1m when idle
const DISPATCH_COOLDOWN_MS = 2 * 60_000; // 2 min — skip agents with recent dispatch activity
const MAX_DISPATCH_ATTEMPTS = 5;

// Escalation constants
const STALE_ESCALATION_THRESHOLD_MS = 4 * 60 * 60 * 1000;
const MAX_RE_ESCALATIONS = 3;
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'] as const;

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Rig config stored per-rig in KV (mirrors what was in Rig DO) ────
type RigConfig = {
  townId: string;
  rigId: string;
  gitUrl: string;
  defaultBranch: string;
  userId: string;
  kilocodeToken?: string;
  platformIntegrationId?: string;
  /** Per-rig merge strategy override. When unset, inherits from town config. */
  merge_strategy?: MergeStrategy;
};

// ── Escalation API type (derived from EscalationBeadRecord) ─────────
type EscalationEntry = {
  id: string;
  source_rig_id: string;
  source_agent_id: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string | null;
  message: string;
  acknowledged: number;
  re_escalation_count: number;
  created_at: string;
  acknowledged_at: string | null;
};

function toEscalation(row: EscalationBeadRecord): EscalationEntry {
  return {
    id: row.bead_id,
    source_rig_id: row.rig_id ?? '',
    source_agent_id: row.created_by,
    severity: row.severity,
    category: row.category,
    message: row.body ?? row.title,
    acknowledged: row.acknowledged,
    re_escalation_count: row.re_escalation_count,
    created_at: row.created_at,
    acknowledged_at: row.acknowledged_at,
  };
}

// ── Convoy API type (derived from ConvoyBeadRecord) ─────────────────
type ConvoyEntry = {
  id: string;
  title: string;
  status: 'active' | 'landed';
  total_beads: number;
  closed_beads: number;
  created_by: string | null;
  created_at: string;
  landed_at: string | null;
  feature_branch: string | null;
  merge_mode: string | null;
};

function toConvoy(row: ConvoyBeadRecord): ConvoyEntry {
  return {
    id: row.bead_id,
    title: row.title,
    status: row.status === 'closed' ? 'landed' : 'active',
    total_beads: row.total_beads,
    closed_beads: row.closed_beads,
    created_by: row.created_by,
    created_at: row.created_at,
    landed_at: row.landed_at,
    feature_branch: row.feature_branch,
    merge_mode: row.merge_mode,
  };
}

const CONVOY_JOIN = /* sql */ `
  SELECT ${beads}.*,
         ${convoy_metadata.total_beads}, ${convoy_metadata.closed_beads},
         ${convoy_metadata.landed_at}, ${convoy_metadata.feature_branch},
         ${convoy_metadata.merge_mode}
  FROM ${beads}
  INNER JOIN ${convoy_metadata} ON ${beads.bead_id} = ${convoy_metadata.bead_id}
`;

const ESCALATION_JOIN = /* sql */ `
  SELECT ${beads}.*,
         ${escalation_metadata.severity}, ${escalation_metadata.category},
         ${escalation_metadata.acknowledged}, ${escalation_metadata.re_escalation_count},
         ${escalation_metadata.acknowledged_at}
  FROM ${beads}
  INNER JOIN ${escalation_metadata} ON ${beads.bead_id} = ${escalation_metadata.bead_id}
`;

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

  // ── WebSocket: status broadcast ──────────────────────────────────────

  /**
   * Handle HTTP requests to the DO. Only used for the /status/ws
   * WebSocket upgrade — all other requests use RPC methods.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname.endsWith('/status/ws') &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      await this.ensureInitialized();
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, ['status']);

      // Send an initial snapshot immediately so the client doesn't
      // wait for the next alarm tick.
      try {
        const snapshot = await this.getAlarmStatus();
        server.send(JSON.stringify(snapshot));
      } catch {
        // Best-effort — snapshot will come on next tick
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  /** Called by the runtime when a hibernated WebSocket receives a message. */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Status WebSocket is server-push only — ignore client messages.
  }

  /** Called by the runtime when a hibernated WebSocket is closed. */
  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    try {
      ws.close();
    } catch {
      // Already closed
    }
  }

  /** Called by the runtime when a hibernated WebSocket errors. */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // Already closed
    }
  }

  /**
   * Broadcast the alarm status snapshot to all connected status WebSocket
   * clients. Called at the end of each alarm tick.
   */
  private broadcastAlarmStatus(snapshot: Awaited<ReturnType<TownDO['getAlarmStatus']>>): void {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;

    const payload = JSON.stringify(snapshot);
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  /**
   * Broadcast a lightweight agent_status event to all connected status
   * WebSocket clients. Called whenever an agent updates its status message.
   */
  private broadcastAgentStatus(agentId: string, message: string): void {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;

    const payload = JSON.stringify({
      type: 'agent_status',
      agentId,
      message,
      timestamp: now(),
    });
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  // ── Initialization ──────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }
    await this.initPromise;
  }

  private async initializeDatabase(): Promise<void> {
    // Load persisted town ID if available
    const storedId = await this.ctx.storage.get<string>('town:id');
    if (storedId) this._townId = storedId;

    // All tables are now initialized via beads.initBeadTables():
    // beads, bead_events, bead_dependencies, agent_metadata, review_metadata,
    // escalation_metadata, convoy_metadata
    beadOps.initBeadTables(this.sql);

    // These are no-ops now but kept for clarity
    agents.initAgentTables(this.sql);
    mail.initMailTables(this.sql);
    reviewQueue.initReviewQueueTables(this.sql);

    // Rig registry
    rigs.initRigTables(this.sql);

    // Ensure the alarm loop is running. After a deploy/restart, the
    // Cloudflare runtime normally delivers missed alarms, but if the alarm
    // was never set or was deleted by destroy(), the loop is dead. Re-arm
    // unconditionally so pending work (idle agents with hooks, open MR beads,
    // stale reviews) gets processed.
    await this.armAlarmIfNeeded();
  }

  private _townId: string | null = null;

  private get townId(): string {
    return this._townId ?? this.ctx.id.name ?? this.ctx.id.toString();
  }

  /**
   * Explicitly set the town ID. Called by configureRig or any handler
   * that knows the real town UUID, so that subsequent internal calls
   * (alarm, sendMayorMessage) use the correct ID for container stubs.
   */
  async setTownId(townId: string): Promise<void> {
    this._townId = townId;
    await this.ctx.storage.put('town:id', townId);
  }

  // ══════════════════════════════════════════════════════════════════
  // Town Configuration
  // ══════════════════════════════════════════════════════════════════

  async getTownConfig(): Promise<TownConfig> {
    return config.getTownConfig(this.ctx.storage);
  }

  async updateTownConfig(update: TownConfigUpdate): Promise<TownConfig> {
    return config.updateTownConfig(this.ctx.storage, update);
  }

  // ══════════════════════════════════════════════════════════════════
  // Rig Registry
  // ══════════════════════════════════════════════════════════════════

  async addRig(input: {
    rigId: string;
    name: string;
    gitUrl: string;
    defaultBranch: string;
  }): Promise<rigs.RigRecord> {
    await this.ensureInitialized();
    return rigs.addRig(this.sql, input);
  }

  async removeRig(rigId: string): Promise<void> {
    await this.ensureInitialized();
    rigs.removeRig(this.sql, rigId);
    await this.ctx.storage.delete(`rig:${rigId}:config`);
    // Delete all beads belonging to this rig (cascades to satellite tables via deleteBead)
    const rigBeads = BeadRecord.pick({ bead_id: true })
      .array()
      .parse([
        ...query(
          this.sql,
          /* sql */ `SELECT ${beads.bead_id} FROM ${beads} WHERE ${beads.rig_id} = ?`,
          [rigId]
        ),
      ]);
    for (const { bead_id } of rigBeads) {
      beadOps.deleteBead(this.sql, bead_id);
    }
  }

  async listRigs(): Promise<rigs.RigRecord[]> {
    await this.ensureInitialized();
    return rigs.listRigs(this.sql);
  }

  async getRigAsync(rigId: string): Promise<rigs.RigRecord | null> {
    await this.ensureInitialized();
    return rigs.getRig(this.sql, rigId);
  }

  // ── Rig Config (KV, per-rig — configuration needed for container dispatch) ──

  async configureRig(rigConfig: RigConfig): Promise<void> {
    console.log(
      `${TOWN_LOG} configureRig: rigId=${rigConfig.rigId} hasKilocodeToken=${!!rigConfig.kilocodeToken}`
    );
    if (rigConfig.townId) {
      await this.setTownId(rigConfig.townId);
    }
    await this.ctx.storage.put(`rig:${rigConfig.rigId}:config`, rigConfig);

    if (rigConfig.kilocodeToken) {
      const townConfig = await this.getTownConfig();
      if (!townConfig.kilocode_token || townConfig.kilocode_token !== rigConfig.kilocodeToken) {
        console.log(`${TOWN_LOG} configureRig: propagating kilocodeToken to town config`);
        await this.updateTownConfig({ kilocode_token: rigConfig.kilocodeToken });
      }
    }

    const token = rigConfig.kilocodeToken ?? (await this.resolveKilocodeToken());
    if (token) {
      try {
        const container = getTownContainerStub(this.env, this.townId);
        await container.setEnvVar('KILOCODE_TOKEN', token);
        console.log(`${TOWN_LOG} configureRig: stored KILOCODE_TOKEN on TownContainerDO`);
      } catch (err) {
        console.warn(`${TOWN_LOG} configureRig: failed to store token on container DO:`, err);
      }
    }

    console.log(`${TOWN_LOG} configureRig: proactively starting container`);
    await this.armAlarmIfNeeded();
    try {
      const container = getTownContainerStub(this.env, this.townId);
      await container.fetch('http://container/health');
    } catch {
      // Container may take a moment to start — the alarm will retry
    }

    // Proactively clone the rig's repo and create a browse worktree so
    // the mayor has immediate access to the codebase without waiting for
    // the first agent dispatch.
    this.setupRigRepoInContainer(rigConfig).catch(err =>
      console.warn(`${TOWN_LOG} configureRig: background repo setup failed:`, err)
    );
  }

  /**
   * Tell the container to clone a rig's repo and create a browse worktree.
   * Fire-and-forget — failures are logged but don't block the caller.
   */
  private async setupRigRepoInContainer(rigConfig: RigConfig): Promise<void> {
    const townConfig = await this.getTownConfig();
    const envVars: Record<string, string> = {};
    if (townConfig.git_auth?.github_token) {
      envVars.GIT_TOKEN = townConfig.git_auth.github_token;
    }
    if (townConfig.git_auth?.gitlab_token) {
      envVars.GITLAB_TOKEN = townConfig.git_auth.gitlab_token;
    }
    if (townConfig.git_auth?.gitlab_instance_url) {
      envVars.GITLAB_INSTANCE_URL = townConfig.git_auth.gitlab_instance_url;
    }
    // resolveGitCredentials in the container needs KILOCODE_TOKEN to
    // authenticate against the credential API for platform integrations.
    const kilocodeToken = rigConfig.kilocodeToken ?? townConfig.kilocode_token;
    if (kilocodeToken) {
      envVars.KILOCODE_TOKEN = kilocodeToken;
    }

    const containerConfig = await config.buildContainerConfig(this.ctx.storage, this.env);
    const container = getTownContainerStub(this.env, this.townId);
    const response = await container.fetch('http://container/repos/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Town-Config': JSON.stringify(containerConfig),
      },
      body: JSON.stringify({
        rigId: rigConfig.rigId,
        gitUrl: rigConfig.gitUrl,
        defaultBranch: rigConfig.defaultBranch,
        envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
        platformIntegrationId: rigConfig.platformIntegrationId,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      console.warn(
        `${TOWN_LOG} setupRigRepoInContainer: failed for rig=${rigConfig.rigId}: ${response.status} ${text.slice(0, 200)}`
      );
    } else {
      console.log(`${TOWN_LOG} setupRigRepoInContainer: accepted for rig=${rigConfig.rigId}`);
    }
  }

  async getRigConfig(rigId: string): Promise<RigConfig | null> {
    return (await this.ctx.storage.get<RigConfig>(`rig:${rigId}:config`)) ?? null;
  }

  // ══════════════════════════════════════════════════════════════════
  // Beads
  // ══════════════════════════════════════════════════════════════════

  async createBead(input: CreateBeadInput): Promise<Bead> {
    await this.ensureInitialized();
    return beadOps.createBead(this.sql, input);
  }

  async getBeadAsync(beadId: string): Promise<Bead | null> {
    await this.ensureInitialized();
    return beadOps.getBead(this.sql, beadId);
  }

  async listBeads(filter: BeadFilter): Promise<Bead[]> {
    await this.ensureInitialized();
    return beadOps.listBeads(this.sql, filter);
  }

  async updateBeadStatus(beadId: string, status: string, agentId: string): Promise<Bead> {
    await this.ensureInitialized();
    // Convoy progress is updated automatically inside beadOps.updateBeadStatus
    // when the bead reaches a terminal status (closed/failed).
    const bead = beadOps.updateBeadStatus(this.sql, beadId, status, agentId);

    // When a bead closes, check if any blocked beads are now unblocked and dispatch them.
    if (status === 'closed' || status === 'failed') {
      this.dispatchUnblockedBeads(beadId);
    }

    return bead;
  }

  async closeBead(beadId: string, agentId: string): Promise<Bead> {
    return this.updateBeadStatus(beadId, 'closed', agentId);
  }

  async deleteBead(beadId: string): Promise<void> {
    await this.ensureInitialized();
    beadOps.deleteBead(this.sql, beadId);
  }

  async listBeadEvents(options: {
    beadId?: string;
    since?: string;
    limit?: number;
  }): Promise<BeadEventRecord[]> {
    await this.ensureInitialized();
    return beadOps.listBeadEvents(this.sql, options);
  }

  // ══════════════════════════════════════════════════════════════════
  // Agents
  // ══════════════════════════════════════════════════════════════════

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    await this.ensureInitialized();
    return agents.registerAgent(this.sql, input);
  }

  async getAgentAsync(agentId: string): Promise<Agent | null> {
    await this.ensureInitialized();
    return agents.getAgent(this.sql, agentId);
  }

  async getAgentByIdentity(identity: string): Promise<Agent | null> {
    await this.ensureInitialized();
    return agents.getAgentByIdentity(this.sql, identity);
  }

  async listAgents(filter?: AgentFilter): Promise<Agent[]> {
    await this.ensureInitialized();
    return agents.listAgents(this.sql, filter);
  }

  async updateAgentStatus(agentId: string, status: string): Promise<void> {
    await this.ensureInitialized();
    agents.updateAgentStatus(this.sql, agentId, status);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.ensureInitialized();
    agents.deleteAgent(this.sql, agentId);
    try {
      const agentDO = getAgentDOStub(this.env, agentId);
      await agentDO.destroy();
    } catch {
      // Best-effort
    }
  }

  async hookBead(agentId: string, beadId: string): Promise<void> {
    await this.ensureInitialized();
    agents.hookBead(this.sql, agentId, beadId);
    await this.armAlarmIfNeeded();
  }

  async unhookBead(agentId: string): Promise<void> {
    await this.ensureInitialized();
    agents.unhookBead(this.sql, agentId);
  }

  async getHookedBead(agentId: string): Promise<Bead | null> {
    await this.ensureInitialized();
    return agents.getHookedBead(this.sql, agentId);
  }

  async getOrCreateAgent(role: AgentRole, rigId: string): Promise<Agent> {
    await this.ensureInitialized();
    return agents.getOrCreateAgent(this.sql, role, rigId, this.townId);
  }

  // ── Agent Events (delegated to AgentDO) ───────────────────────────

  async appendAgentEvent(agentId: string, eventType: string, data: unknown): Promise<number> {
    const agentDO = getAgentDOStub(this.env, agentId);
    return agentDO.appendEvent(eventType, data);
  }

  async getAgentEvents(agentId: string, afterId?: number, limit?: number): Promise<unknown[]> {
    const agentDO = getAgentDOStub(this.env, agentId);
    return agentDO.getEvents(afterId, limit);
  }

  // ── Prime & Checkpoint ────────────────────────────────────────────

  async prime(agentId: string): Promise<PrimeContext> {
    await this.ensureInitialized();
    return agents.prime(this.sql, agentId);
  }

  async writeCheckpoint(agentId: string, data: unknown): Promise<void> {
    await this.ensureInitialized();
    agents.writeCheckpoint(this.sql, agentId, data);
  }

  async readCheckpoint(agentId: string): Promise<unknown> {
    await this.ensureInitialized();
    return agents.readCheckpoint(this.sql, agentId);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────

  async touchAgentHeartbeat(agentId: string): Promise<void> {
    await this.ensureInitialized();
    agents.touchAgent(this.sql, agentId);
    await this.armAlarmIfNeeded();
  }

  async updateAgentStatusMessage(agentId: string, message: string): Promise<void> {
    await this.ensureInitialized();
    agents.updateAgentStatusMessage(this.sql, agentId, message);
    const agent = agents.getAgent(this.sql, agentId);
    if (agent?.current_hook_bead_id) {
      const rig = agent.rig_id ? rigs.getRig(this.sql, agent.rig_id) : null;
      beadOps.logBeadEvent(this.sql, {
        beadId: agent.current_hook_bead_id,
        agentId,
        eventType: 'agent_status',
        newValue: message,
        metadata: {
          agentId,
          message,
          agent_name: agent.name,
          rig_id: agent.rig_id,
          rig_name: rig?.name,
        },
      });
    }
    this.broadcastAgentStatus(agentId, message);
  }

  // ══════════════════════════════════════════════════════════════════
  // Mail
  // ══════════════════════════════════════════════════════════════════

  async sendMail(input: SendMailInput): Promise<void> {
    await this.ensureInitialized();
    mail.sendMail(this.sql, input);
  }

  async checkMail(agentId: string): Promise<Mail[]> {
    await this.ensureInitialized();
    return mail.checkMail(this.sql, agentId);
  }

  // ══════════════════════════════════════════════════════════════════
  // Review Queue & Molecules
  // ══════════════════════════════════════════════════════════════════

  async submitToReviewQueue(input: ReviewQueueInput): Promise<void> {
    await this.ensureInitialized();
    reviewQueue.submitToReviewQueue(this.sql, input);
    await this.armAlarmIfNeeded();
  }

  async popReviewQueue(): Promise<ReviewQueueEntry | null> {
    await this.ensureInitialized();
    return reviewQueue.popReviewQueue(this.sql);
  }

  async completeReview(entryId: string, status: 'merged' | 'failed'): Promise<void> {
    await this.ensureInitialized();
    reviewQueue.completeReview(this.sql, entryId, status);
  }

  async completeReviewWithResult(input: {
    entry_id: string;
    status: 'merged' | 'failed' | 'conflict';
    message?: string;
    commit_sha?: string;
  }): Promise<void> {
    await this.ensureInitialized();

    // Resolve the source bead ID before completing the review, so we can
    // trigger dispatchUnblockedBeads for it after the MR closes.
    const mrBead = beadOps.getBead(this.sql, input.entry_id);
    const sourceBeadId =
      typeof mrBead?.metadata?.source_bead_id === 'string' ? mrBead.metadata.source_bead_id : null;

    reviewQueue.completeReviewWithResult(this.sql, input);

    // When a review is merged, the source bead's pending MR is now resolved.
    // Downstream beads that were blocked (because hasUnresolvedBlockers saw
    // the open MR) should now be dispatched.
    if (input.status === 'merged' && sourceBeadId) {
      this.dispatchUnblockedBeads(sourceBeadId);
    }

    // When a review fails or conflicts (rework), the source bead was
    // returned to in_progress. Re-hook a polecat and re-dispatch so the
    // rework starts automatically. The original polecat may already be
    // working on something else, so fall back to getOrCreateAgent.
    if ((input.status === 'failed' || input.status === 'conflict') && sourceBeadId) {
      const sourceBead = beadOps.getBead(this.sql, sourceBeadId);
      if (sourceBead?.rig_id) {
        try {
          const reworkAgent = agents.getOrCreateAgent(
            this.sql,
            'polecat',
            sourceBead.rig_id,
            this.townId
          );
          agents.hookBead(this.sql, reworkAgent.id, sourceBeadId);
          this.dispatchAgent(reworkAgent, sourceBead).catch(err =>
            console.error(
              `${TOWN_LOG} completeReviewWithResult: fire-and-forget rework dispatch failed for bead=${sourceBeadId}`,
              err
            )
          );
        } catch (err) {
          console.warn(
            `${TOWN_LOG} completeReviewWithResult: could not dispatch rework for bead=${sourceBeadId}:`,
            err
          );
        }
      }
    }
  }

  async agentDone(agentId: string, input: AgentDoneInput): Promise<void> {
    await this.ensureInitialized();
    reviewQueue.agentDone(this.sql, agentId, input);
    await this.armAlarmIfNeeded();
  }

  async agentCompleted(
    agentId: string,
    input: { status: 'completed' | 'failed'; reason?: string }
  ): Promise<void> {
    await this.ensureInitialized();
    let resolvedAgentId = agentId;
    if (!resolvedAgentId) {
      const mayor = agents.listAgents(this.sql, { role: 'mayor' })[0];
      if (mayor) resolvedAgentId = mayor.id;
    }
    if (resolvedAgentId) {
      reviewQueue.agentCompleted(this.sql, resolvedAgentId, input);
    }
  }

  /**
   * Resolve a triage_request bead. Called by the triage agent via the
   * gt_triage_resolve tool. Applies the chosen action, closes the
   * triage request, and logs the resolution.
   */
  async resolveTriage(input: {
    agent_id: string;
    triage_request_bead_id: string;
    action: string;
    resolution_notes: string;
  }): Promise<Bead> {
    await this.ensureInitialized();
    const triageBead = beadOps.getBead(this.sql, input.triage_request_bead_id);
    if (!triageBead)
      throw new Error(`Triage request bead ${input.triage_request_bead_id} not found`);
    if (!triageBead.labels.includes(patrol.TRIAGE_REQUEST_LABEL)) {
      throw new Error(`Bead ${input.triage_request_bead_id} is not a triage request`);
    }
    if (triageBead.status !== 'open') {
      throw new Error(
        `Triage request ${input.triage_request_bead_id} is already ${triageBead.status} — cannot resolve again`
      );
    }

    // ── Apply the chosen action ────────────────────────────────────
    const targetAgentId =
      typeof triageBead.metadata?.agent_bead_id === 'string'
        ? triageBead.metadata.agent_bead_id
        : null;
    // Use the hooked bead ID captured when the triage request was created,
    // not the agent's current hook (which may have changed since then).
    const snapshotHookedBeadId =
      typeof triageBead.metadata?.hooked_bead_id === 'string'
        ? triageBead.metadata.hooked_bead_id
        : null;
    const action = input.action.toUpperCase();

    if (targetAgentId) {
      const targetAgent = agents.getAgent(this.sql, targetAgentId);

      switch (action) {
        case 'RESTART':
        case 'RESTART_WITH_BACKOFF': {
          // Stop the agent in the container, reset to idle so the
          // scheduler picks it up again on the next alarm cycle.
          if (targetAgent?.status === 'working' || targetAgent?.status === 'stalled') {
            dispatch.stopAgentInContainer(this.env, this.townId, targetAgentId).catch(() => {});
          }
          if (targetAgent) {
            // RESTART clears last_activity_at so the scheduler picks it
            // up immediately. RESTART_WITH_BACKOFF sets it to now() so
            // the dispatch cooldown (DISPATCH_COOLDOWN_MS) delays the
            // next attempt, preventing immediate restart of crash loops.
            const activityAt = action === 'RESTART_WITH_BACKOFF' ? now() : null;
            query(
              this.sql,
              /* sql */ `
                UPDATE ${agent_metadata}
                SET ${agent_metadata.columns.status} = 'idle',
                    ${agent_metadata.columns.last_activity_at} = ?
                WHERE ${agent_metadata.bead_id} = ?
              `,
              [activityAt, targetAgentId]
            );
          }
          break;
        }
        case 'CLOSE_BEAD': {
          // Fail the bead that was hooked when the triage request was
          // created (not the agent's current hook, which may differ).
          const beadToClose = snapshotHookedBeadId ?? targetAgent?.current_hook_bead_id;
          if (beadToClose) {
            beadOps.updateBeadStatus(this.sql, beadToClose, 'failed', input.agent_id);
            // Only stop and unhook if the agent is still working on this
            // specific bead. If the agent has moved on, stopping it would
            // abort unrelated work.
            if (targetAgent?.current_hook_bead_id === beadToClose) {
              if (targetAgent.status === 'working' || targetAgent.status === 'stalled') {
                dispatch.stopAgentInContainer(this.env, this.townId, targetAgentId).catch(() => {});
              }
              agents.unhookBead(this.sql, targetAgentId);
            }
          }
          break;
        }
        case 'ESCALATE_TO_MAYOR':
        case 'ESCALATE': {
          const message = input.resolution_notes || triageBead.title || 'Triage escalation';
          this.sendMayorMessage(
            `[Triage Escalation] ${message}\n\nAgent: ${targetAgentId ?? 'unknown'}\nBead: ${snapshotHookedBeadId ?? 'unknown'}`
          ).catch(err =>
            console.warn(`${TOWN_LOG} resolveTriage: mayor notification failed:`, err)
          );
          break;
        }
        case 'NUDGE': {
          // Send a nudge message to the stuck agent
          if (targetAgent) {
            mail.sendMail(this.sql, {
              from_agent_id: 'patrol',
              to_agent_id: targetAgentId,
              subject: 'TRIAGE_NUDGE',
              body:
                input.resolution_notes ||
                'The triage system has flagged you as potentially stuck. Please report your status.',
            });
          }
          break;
        }
        case 'REASSIGN_BEAD': {
          // Target the bead from the triage snapshot, not the agent's current hook.
          const beadToReassign = snapshotHookedBeadId ?? targetAgent?.current_hook_bead_id;
          if (beadToReassign) {
            // Only stop and unhook if the agent is still working on this
            // specific bead. If the agent has moved on, stopping it would
            // abort unrelated work.
            if (targetAgent?.current_hook_bead_id === beadToReassign) {
              if (targetAgent.status === 'working' || targetAgent.status === 'stalled') {
                dispatch.stopAgentInContainer(this.env, this.townId, targetAgentId).catch(() => {});
              }
              agents.unhookBead(this.sql, targetAgentId);
            }
            // Reset the bead to open so the scheduler can re-assign it
            query(
              this.sql,
              /* sql */ `
                UPDATE ${beads}
                SET ${beads.columns.assignee_agent_bead_id} = NULL,
                    ${beads.columns.status} = 'open',
                    ${beads.columns.updated_at} = ?
                WHERE ${beads.bead_id} = ?
                  AND ${beads.status} != 'closed'
                  AND ${beads.status} != 'failed'
              `,
              [now(), beadToReassign]
            );
          }
          break;
        }
        // DISCARD, PROVIDE_GUIDANCE, and other informational actions
        // are handled by the triage agent itself via gt_mail_send
        // before calling gt_triage_resolve — no server-side effect needed.
        default:
          break;
      }
    }

    // ── Close the triage request bead with resolution metadata ──────
    const timestamp = now();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.status} = 'closed',
            ${beads.columns.closed_at} = ?,
            ${beads.columns.updated_at} = ?,
            ${beads.columns.metadata} = json_set(
              COALESCE(${beads.metadata}, '{}'),
              '$.resolution_action', ?,
              '$.resolution_notes', ?,
              '$.resolved_by', ?
            )
        WHERE ${beads.bead_id} = ?
      `,
      [
        timestamp,
        timestamp,
        input.action,
        input.resolution_notes,
        input.agent_id,
        input.triage_request_bead_id,
      ]
    );

    beadOps.logBeadEvent(this.sql, {
      beadId: input.triage_request_bead_id,
      agentId: input.agent_id,
      eventType: 'status_changed',
      oldValue: triageBead.status,
      newValue: 'closed',
      metadata: {
        action: input.action,
        resolution_notes: input.resolution_notes,
      },
    });

    // Log a triage_resolved event on the target bead so the action shows
    // up in the activity feed for the bead that was actually affected.
    const targetBeadId = snapshotHookedBeadId ?? targetAgentId;
    if (targetBeadId && targetBeadId !== input.triage_request_bead_id) {
      beadOps.logBeadEvent(this.sql, {
        beadId: targetBeadId,
        agentId: input.agent_id,
        eventType: 'triage_resolved',
        newValue: action,
        metadata: {
          action,
          resolution_notes: input.resolution_notes,
          triage_request_bead_id: input.triage_request_bead_id,
          target_agent_id: targetAgentId,
        },
      });
    }

    // If this triage request was created for an escalation, close the
    // linked escalation bead too so it doesn't sit open indefinitely.
    // The escalation_bead_id is nested under metadata.context (set by
    // createTriageRequest's TriageRequestMetadata structure).
    const ctx =
      typeof triageBead.metadata?.context === 'object' && triageBead.metadata.context !== null
        ? (triageBead.metadata.context as Record<string, unknown>)
        : null;
    const escalationBeadId =
      typeof ctx?.escalation_bead_id === 'string' ? ctx.escalation_bead_id : null;
    if (escalationBeadId) {
      beadOps.updateBeadStatus(this.sql, escalationBeadId, 'closed', input.agent_id);
    }

    console.log(
      `${TOWN_LOG} resolveTriage: bead=${input.triage_request_bead_id} action=${input.action}`
    );

    const updated = beadOps.getBead(this.sql, input.triage_request_bead_id);
    if (!updated) throw new Error('Triage bead not found after update');
    return updated;
  }

  async createMolecule(beadId: string, formula: unknown): Promise<Molecule> {
    await this.ensureInitialized();
    return reviewQueue.createMolecule(this.sql, beadId, formula);
  }

  async getMoleculeCurrentStep(
    agentId: string
  ): Promise<{ molecule: Molecule; step: unknown } | null> {
    await this.ensureInitialized();
    return reviewQueue.getMoleculeCurrentStep(this.sql, agentId);
  }

  async advanceMoleculeStep(agentId: string, summary: string): Promise<Molecule | null> {
    await this.ensureInitialized();
    return reviewQueue.advanceMoleculeStep(this.sql, agentId, summary);
  }

  // ══════════════════════════════════════════════════════════════════
  // Atomic Sling (create bead + agent + hook)
  // ══════════════════════════════════════════════════════════════════

  async slingBead(input: {
    rigId: string;
    title: string;
    body?: string;
    priority?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ bead: Bead; agent: Agent }> {
    await this.ensureInitialized();

    const createdBead = beadOps.createBead(this.sql, {
      type: 'issue',
      title: input.title,
      body: input.body,
      priority: BeadPriority.catch('medium').parse(input.priority ?? 'medium'),
      rig_id: input.rigId,
      metadata: input.metadata,
    });

    const agent = agents.getOrCreateAgent(this.sql, 'polecat', input.rigId, this.townId);
    agents.hookBead(this.sql, agent.id, createdBead.bead_id);

    // Re-read bead and agent after hook (hookBead updates both)
    const bead = beadOps.getBead(this.sql, createdBead.bead_id) ?? createdBead;
    const hookedAgent = agents.getAgent(this.sql, agent.id) ?? agent;

    // Fire-and-forget dispatch so the sling call returns immediately.
    // The alarm loop retries if this fails.
    this.dispatchAgent(hookedAgent, bead).catch(err =>
      console.error(`${TOWN_LOG} slingBead: fire-and-forget dispatchAgent failed:`, err)
    );
    await this.armAlarmIfNeeded();
    return { bead, agent: hookedAgent };
  }

  /** Build the rig list for mayor agent startup (browse worktree setup on fresh containers). */
  private async rigListForMayor(): Promise<
    Array<{ rigId: string; gitUrl: string; defaultBranch: string; platformIntegrationId?: string }>
  > {
    const rigRecords = rigs.listRigs(this.sql);
    return Promise.all(
      rigRecords.map(async r => {
        const rc = await this.getRigConfig(r.id);
        return {
          rigId: r.id,
          gitUrl: r.git_url,
          defaultBranch: r.default_branch,
          platformIntegrationId: rc?.platformIntegrationId,
        };
      })
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // Mayor (just another agent)
  // ══════════════════════════════════════════════════════════════════

  async sendMayorMessage(
    message: string,
    _model?: string
  ): Promise<{ agentId: string; sessionStatus: 'idle' | 'active' | 'starting' }> {
    await this.ensureInitialized();
    const townId = this.townId;

    let mayor = agents.listAgents(this.sql, { role: 'mayor' })[0] ?? null;
    if (!mayor) {
      const identity = `mayor-${townId.slice(0, 8)}`;
      mayor = agents.registerAgent(this.sql, {
        role: 'mayor',
        name: 'mayor',
        identity,
      });
    }

    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, townId, mayor.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';

    console.log(
      `${TOWN_LOG} sendMayorMessage: townId=${townId} mayorId=${mayor.id} containerStatus=${containerStatus.status} isAlive=${isAlive}`
    );

    let sessionStatus: 'idle' | 'active' | 'starting';

    if (isAlive) {
      const sent = await dispatch.sendMessageToAgent(this.env, townId, mayor.id, message);
      sessionStatus = sent ? 'active' : 'idle';
    } else {
      const townConfig = await this.getTownConfig();
      const rigConfig = await this.getMayorRigConfig();
      const kilocodeToken = await this.resolveKilocodeToken();

      console.log(
        `${TOWN_LOG} sendMayorMessage: townId=${townId} hasRigConfig=${!!rigConfig} hasKilocodeToken=${!!kilocodeToken} townConfigToken=${!!townConfig.kilocode_token} rigConfigToken=${!!rigConfig?.kilocodeToken}`
      );

      if (kilocodeToken) {
        try {
          const containerStub = getTownContainerStub(this.env, townId);
          await containerStub.setEnvVar('KILOCODE_TOKEN', kilocodeToken);
        } catch {
          // Best effort
        }
      }

      const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
        townId,
        rigId: `mayor-${townId}`,
        userId: townConfig.owner_user_id ?? rigConfig?.userId ?? townId,
        agentId: mayor.id,
        agentName: 'mayor',
        role: 'mayor',
        identity: mayor.identity,
        beadId: '',
        beadTitle: message,
        beadBody: '',
        checkpoint: null,
        gitUrl: rigConfig?.gitUrl ?? '',
        defaultBranch: rigConfig?.defaultBranch ?? 'main',
        kilocodeToken,
        townConfig,
        rigs: await this.rigListForMayor(),
      });

      if (started) {
        agents.updateAgentStatus(this.sql, mayor.id, 'working');
        sessionStatus = 'starting';
      } else {
        sessionStatus = 'idle';
      }
    }

    await this.armAlarmIfNeeded();
    return { agentId: mayor.id, sessionStatus };
  }

  /**
   * Ensure the mayor agent exists and its container is running.
   * Called eagerly on page load so the terminal is available immediately
   * without requiring the user to send a message first.
   */
  async ensureMayor(): Promise<{ agentId: string; sessionStatus: 'idle' | 'active' | 'starting' }> {
    await this.ensureInitialized();
    const townId = this.townId;

    let mayor = agents.listAgents(this.sql, { role: 'mayor' })[0] ?? null;
    if (!mayor) {
      const identity = `mayor-${townId.slice(0, 8)}`;
      mayor = agents.registerAgent(this.sql, {
        role: 'mayor',
        name: 'mayor',
        identity,
      });
      console.log(`${TOWN_LOG} ensureMayor: created mayor agent ${mayor.id}`);
    }

    // Check if the container is already running
    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, townId, mayor.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';

    if (isAlive) {
      const status = mayor.status === 'working' || mayor.status === 'stalled' ? 'active' : 'idle';
      return { agentId: mayor.id, sessionStatus: status };
    }

    // Start the container with an idle mayor (no initial prompt)
    const townConfig = await this.getTownConfig();
    const rigConfig = await this.getMayorRigConfig();
    const kilocodeToken = await this.resolveKilocodeToken();

    // Don't start without a kilocode token — the session would use the
    // default free model and have no provider credentials. The frontend
    // will retry via status polling once a rig is created and the token
    // becomes available.
    if (!kilocodeToken) {
      console.warn(`${TOWN_LOG} ensureMayor: no kilocodeToken available, deferring start`);
      return { agentId: mayor.id, sessionStatus: 'idle' };
    }

    try {
      const containerStub = getTownContainerStub(this.env, townId);
      await containerStub.setEnvVar('KILOCODE_TOKEN', kilocodeToken);
    } catch {
      // Best effort
    }

    // Start with an empty prompt — the mayor will be idle but its container
    // and SDK server will be running, ready for PTY connections.
    const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
      townId,
      rigId: `mayor-${townId}`,
      userId: townConfig.owner_user_id ?? rigConfig?.userId ?? '',
      agentId: mayor.id,
      agentName: 'mayor',
      role: 'mayor',
      identity: mayor.identity,
      beadId: '',
      beadTitle: 'Mayor ready. Waiting for instructions.',
      beadBody: '',
      checkpoint: null,
      gitUrl: rigConfig?.gitUrl ?? '',
      defaultBranch: rigConfig?.defaultBranch ?? 'main',
      kilocodeToken,
      townConfig,
      rigs: await this.rigListForMayor(),
    });

    if (started) {
      agents.updateAgentStatus(this.sql, mayor.id, 'working');
      return { agentId: mayor.id, sessionStatus: 'starting' };
    }

    return { agentId: mayor.id, sessionStatus: 'idle' };
  }

  async getMayorStatus(): Promise<{
    configured: boolean;
    townId: string;
    session: {
      agentId: string;
      sessionId: string;
      status: 'idle' | 'active' | 'starting';
      lastActivityAt: string;
    } | null;
  }> {
    await this.ensureInitialized();
    const mayor = agents.listAgents(this.sql, { role: 'mayor' })[0] ?? null;

    const mapStatus = (agentStatus: string): 'idle' | 'active' | 'starting' => {
      switch (agentStatus) {
        case 'working':
          return 'active';
        case 'stalled':
          return 'active';
        default:
          return 'idle';
      }
    };

    return {
      configured: true,
      townId: this.townId,
      session: mayor
        ? {
            agentId: mayor.id,
            sessionId: mayor.id,
            status: mapStatus(mayor.status),
            lastActivityAt: mayor.last_activity_at ?? mayor.created_at,
          }
        : null,
    };
  }

  private async getMayorRigConfig(): Promise<RigConfig | null> {
    const rigList = rigs.listRigs(this.sql);
    if (rigList.length === 0) return null;
    return this.getRigConfig(rigList[0].id);
  }

  private async resolveKilocodeToken(): Promise<string | undefined> {
    const townConfig = await this.getTownConfig();
    if (townConfig.kilocode_token) return townConfig.kilocode_token;

    const rigList = rigs.listRigs(this.sql);
    for (const rig of rigList) {
      const rc = await this.getRigConfig(rig.id);
      if (rc?.kilocodeToken) {
        await this.updateTownConfig({ kilocode_token: rc.kilocodeToken });
        return rc.kilocodeToken;
      }
    }

    return undefined;
  }

  // ══════════════════════════════════════════════════════════════════
  // Convoys (beads with type='convoy' + convoy_metadata + bead_dependencies)
  // ══════════════════════════════════════════════════════════════════

  async createConvoy(input: {
    title: string;
    beads: Array<{ bead_id: string; rig_id: string }>;
    created_by?: string;
  }): Promise<ConvoyEntry> {
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

    // Create the convoy bead
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${beads} (
          ${beads.columns.bead_id}, ${beads.columns.type}, ${beads.columns.status},
          ${beads.columns.title}, ${beads.columns.body}, ${beads.columns.rig_id},
          ${beads.columns.parent_bead_id}, ${beads.columns.assignee_agent_bead_id},
          ${beads.columns.priority}, ${beads.columns.labels}, ${beads.columns.metadata},
          ${beads.columns.created_by}, ${beads.columns.created_at}, ${beads.columns.updated_at},
          ${beads.columns.closed_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        convoyId,
        'convoy',
        'open',
        parsed.title,
        null,
        null,
        null,
        null,
        'medium',
        JSON.stringify(['gt:convoy']),
        '{}',
        parsed.created_by ?? null,
        timestamp,
        timestamp,
        null,
      ]
    );

    // Create convoy_metadata
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${convoy_metadata} (
          ${convoy_metadata.columns.bead_id}, ${convoy_metadata.columns.total_beads},
          ${convoy_metadata.columns.closed_beads}, ${convoy_metadata.columns.landed_at}
        ) VALUES (?, ?, ?, ?)
      `,
      [convoyId, parsed.beads.length, 0, null]
    );

    // Track beads via bead_dependencies
    for (const bead of parsed.beads) {
      query(
        this.sql,
        /* sql */ `
          INSERT INTO ${bead_dependencies} (
            ${bead_dependencies.columns.bead_id},
            ${bead_dependencies.columns.depends_on_bead_id},
            ${bead_dependencies.columns.dependency_type}
          ) VALUES (?, ?, ?)
        `,
        [bead.bead_id, convoyId, 'tracks']
      );
    }

    const convoy = this.getConvoy(convoyId);
    if (!convoy) throw new Error('Failed to create convoy');
    return convoy;
  }

  async onBeadClosed(input: { convoyId: string; beadId: string }): Promise<ConvoyEntry | null> {
    await this.ensureInitialized();

    // Count closed tracked beads
    const closedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(1) AS count FROM ${bead_dependencies}
          INNER JOIN ${beads} ON ${bead_dependencies.bead_id} = ${beads.bead_id}
          WHERE ${bead_dependencies.depends_on_bead_id} = ?
            AND ${bead_dependencies.dependency_type} = 'tracks'
            AND ${beads.status} = 'closed'
        `,
        [input.convoyId]
      ),
    ];
    const closedCount = z.object({ count: z.number() }).parse(closedRows[0] ?? { count: 0 }).count;

    query(
      this.sql,
      /* sql */ `
        UPDATE ${convoy_metadata}
        SET ${convoy_metadata.columns.closed_beads} = ?
        WHERE ${convoy_metadata.bead_id} = ?
      `,
      [closedCount, input.convoyId]
    );

    const convoy = this.getConvoy(input.convoyId);
    if (convoy && convoy.status === 'active' && convoy.closed_beads >= convoy.total_beads) {
      const timestamp = now();
      query(
        this.sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.status} = 'closed', ${beads.columns.closed_at} = ?, ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [timestamp, timestamp, input.convoyId]
      );
      query(
        this.sql,
        /* sql */ `
          UPDATE ${convoy_metadata}
          SET ${convoy_metadata.columns.landed_at} = ?
          WHERE ${convoy_metadata.bead_id} = ?
        `,
        [timestamp, input.convoyId]
      );
      return this.getConvoy(input.convoyId);
    }
    return convoy;
  }

  /**
   * Force-close a convoy and all its tracked beads. Unhooks any agents
   * still assigned to those beads so they return to the idle pool.
   */
  async closeConvoy(convoyId: string): Promise<ConvoyEntry | null> {
    await this.ensureInitialized();

    const convoy = this.getConvoy(convoyId);
    if (!convoy) return null;

    const timestamp = now();

    // Find all tracked beads
    const trackedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${beads.bead_id}, ${beads.status}, ${beads.assignee_agent_bead_id}
          FROM ${bead_dependencies}
          INNER JOIN ${beads} ON ${bead_dependencies.bead_id} = ${beads.bead_id}
          WHERE ${bead_dependencies.depends_on_bead_id} = ?
            AND ${bead_dependencies.dependency_type} = 'tracks'
        `,
        [convoyId]
      ),
    ];

    const TrackedRow = z.object({
      bead_id: z.string(),
      status: z.string(),
      assignee_agent_bead_id: z.string().nullable(),
    });

    for (const raw of trackedRows) {
      const row = TrackedRow.parse(raw);
      if (row.status === 'closed' || row.status === 'failed') continue;

      // Unhook agent if still assigned
      if (row.assignee_agent_bead_id) {
        try {
          agents.unhookBead(this.sql, row.assignee_agent_bead_id);
        } catch (err) {
          console.warn(
            `${TOWN_LOG} closeConvoy: unhookBead failed for agent=${row.assignee_agent_bead_id}`,
            err
          );
        }
      }

      beadOps.updateBeadStatus(this.sql, row.bead_id, 'closed', 'system');
    }

    // Close the convoy bead itself if not already auto-landed by
    // updateConvoyProgress (which fires when the last tracked bead closes).
    const current = this.getConvoy(convoyId);
    if (current && current.status !== 'landed') {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.status} = 'closed',
              ${beads.columns.closed_at} = ?,
              ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [timestamp, timestamp, convoyId]
      );
      query(
        this.sql,
        /* sql */ `
          UPDATE ${convoy_metadata}
          SET ${convoy_metadata.columns.closed_beads} = ${convoy_metadata.columns.total_beads},
              ${convoy_metadata.columns.landed_at} = ?
          WHERE ${convoy_metadata.bead_id} = ?
        `,
        [timestamp, convoyId]
      );
    }

    console.log(`${TOWN_LOG} closeConvoy: force-closed convoy=${convoyId}`);
    return this.getConvoy(convoyId);
  }

  /**
   * Atomic batch sling: create N beads + 1 convoy, assign polecats, dispatch.
   * Used by the Mayor's gt_sling_batch tool.
   */
  async slingConvoy(input: {
    rigId: string;
    convoyTitle: string;
    tasks: Array<{ title: string; body?: string; depends_on?: number[] }>;
    merge_mode?: 'review-then-land' | 'review-and-merge';
  }): Promise<{ convoy: ConvoyEntry; beads: Array<{ bead: Bead; agent: Agent }> }> {
    await this.ensureInitialized();

    const convoyId = generateId();
    const timestamp = now();

    // Generate a feature branch name for this convoy.
    // Convention: convoy/<slug>/<id-prefix>/head
    // The /head suffix is required because git refs are file-based: a branch
    // at path X prevents branches under X/. Agent branches live under
    // <featureBranch>/gt/<agent>/<bead>, so the feature branch itself must
    // end with a path component (/head) to act as a directory prefix.
    const convoySlug =
      input.convoyTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'convoy';
    const featureBranch = `convoy/${convoySlug}/${convoyId.slice(0, 8)}/head`;

    // 1. Validate the dependency graph has no cycles BEFORE persisting anything.
    // Kahn's algorithm: if we can't visit all nodes, there's a cycle.
    {
      const adj = new Map<number, number[]>();
      const inDegree = new Map<number, number>();
      for (let i = 0; i < input.tasks.length; i++) {
        adj.set(i, []);
        inDegree.set(i, 0);
      }
      for (let i = 0; i < input.tasks.length; i++) {
        for (const depIdx of input.tasks[i].depends_on ?? []) {
          if (depIdx < 0 || depIdx >= input.tasks.length || depIdx === i) continue;
          (adj.get(depIdx) ?? []).push(i);
          inDegree.set(i, (inDegree.get(i) ?? 0) + 1);
        }
      }
      const queue: number[] = [];
      for (const [node, deg] of inDegree) {
        if (deg === 0) queue.push(node);
      }
      let visited = 0;
      while (queue.length > 0) {
        const node = queue.shift();
        if (node === undefined) break;
        visited++;
        for (const neighbor of adj.get(node) ?? []) {
          const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newDeg);
          if (newDeg === 0) queue.push(neighbor);
        }
      }
      if (visited < input.tasks.length) {
        throw new Error(
          `Convoy dependency graph contains a cycle — ${input.tasks.length - visited} tasks are involved in circular dependencies`
        );
      }
    }

    // 2. Create convoy bead + convoy_metadata
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${beads} (
          ${beads.columns.bead_id}, ${beads.columns.type}, ${beads.columns.status},
          ${beads.columns.title}, ${beads.columns.body}, ${beads.columns.rig_id},
          ${beads.columns.parent_bead_id}, ${beads.columns.assignee_agent_bead_id},
          ${beads.columns.priority}, ${beads.columns.labels}, ${beads.columns.metadata},
          ${beads.columns.created_by}, ${beads.columns.created_at}, ${beads.columns.updated_at},
          ${beads.columns.closed_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        convoyId,
        'convoy',
        'open',
        input.convoyTitle,
        null, // body
        null, // rig_id — intentionally null; a convoy is a town-level grouping that can span multiple rigs
        null, // parent_bead_id
        null, // assignee_agent_bead_id
        'medium',
        JSON.stringify(['gt:convoy']),
        JSON.stringify({ feature_branch: featureBranch }),
        null,
        timestamp,
        timestamp,
        null,
      ]
    );

    const mergeMode = input.merge_mode ?? 'review-then-land';

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${convoy_metadata} (
          ${convoy_metadata.columns.bead_id}, ${convoy_metadata.columns.total_beads},
          ${convoy_metadata.columns.closed_beads}, ${convoy_metadata.columns.landed_at},
          ${convoy_metadata.columns.feature_branch}, ${convoy_metadata.columns.merge_mode}
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [convoyId, input.tasks.length, 0, null, featureBranch, mergeMode]
    );

    // 2. Create all beads and track their IDs (needed for depends_on resolution)
    const beadIds: string[] = [];
    const results: Array<{ bead: Bead; agent: Agent }> = [];

    for (const task of input.tasks) {
      const createdBead = beadOps.createBead(this.sql, {
        type: 'issue',
        title: task.title,
        body: task.body,
        priority: 'medium',
        rig_id: input.rigId,
        metadata: { convoy_id: convoyId, feature_branch: featureBranch },
      });
      beadIds.push(createdBead.bead_id);

      // Link bead → convoy via 'tracks'
      query(
        this.sql,
        /* sql */ `
          INSERT INTO ${bead_dependencies} (
            ${bead_dependencies.columns.bead_id},
            ${bead_dependencies.columns.depends_on_bead_id},
            ${bead_dependencies.columns.dependency_type}
          ) VALUES (?, ?, ?)
        `,
        [createdBead.bead_id, convoyId, 'tracks']
      );
    }

    // 4. Create 'blocks' dependencies from depends_on indices
    for (let i = 0; i < input.tasks.length; i++) {
      const deps = input.tasks[i].depends_on;
      if (!deps || deps.length === 0) continue;
      for (const depIdx of deps) {
        if (depIdx < 0 || depIdx >= beadIds.length || depIdx === i) continue;
        query(
          this.sql,
          /* sql */ `
            INSERT OR IGNORE INTO ${bead_dependencies} (
              ${bead_dependencies.columns.bead_id},
              ${bead_dependencies.columns.depends_on_bead_id},
              ${bead_dependencies.columns.dependency_type}
            ) VALUES (?, ?, ?)
          `,
          [beadIds[i], beadIds[depIdx], 'blocks']
        );
      }
    }

    // 4. For each bead: assign a polecat, but only dispatch if unblocked
    for (let i = 0; i < beadIds.length; i++) {
      const beadId = beadIds[i];
      const agent = agents.getOrCreateAgent(this.sql, 'polecat', input.rigId, this.townId);
      agents.hookBead(this.sql, agent.id, beadId);

      const bead = beadOps.getBead(this.sql, beadId);
      const hookedAgent = agents.getAgent(this.sql, agent.id) ?? agent;
      if (!bead) continue;

      // Only dispatch beads with no unresolved blockers
      if (!beadOps.hasUnresolvedBlockers(this.sql, beadId)) {
        this.dispatchAgent(hookedAgent, bead).catch(err =>
          console.error(`${TOWN_LOG} slingConvoy: fire-and-forget dispatchAgent failed:`, err)
        );
      } else {
        console.log(
          `${TOWN_LOG} slingConvoy: bead=${beadId} blocked, deferring dispatch until deps close`
        );
      }

      results.push({ bead, agent: hookedAgent });
    }

    await this.armAlarmIfNeeded();

    const convoy = this.getConvoy(convoyId);
    if (!convoy) throw new Error('Failed to create convoy');
    return { convoy, beads: results };
  }

  /**
   * List active convoys with progress counts.
   */
  async listConvoys(): Promise<ConvoyEntry[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `${CONVOY_JOIN}
          WHERE ${beads.status} != 'closed'
          ORDER BY ${beads.created_at} DESC`,
        []
      ),
    ];
    return rows.map(row => toConvoy(ConvoyBeadRecord.parse(row)));
  }

  /**
   * List active convoys with full per-bead breakdown in a single DO call.
   * Avoids N+1 RPC fan-out from calling getConvoyStatus for each convoy.
   */
  async listConvoysDetailed(): Promise<
    Array<
      ConvoyEntry & {
        beads: Array<{
          bead_id: string;
          title: string;
          status: string;
          rig_id: string | null;
          assignee_agent_name: string | null;
        }>;
        dependency_edges: Array<{
          bead_id: string;
          depends_on_bead_id: string;
        }>;
      }
    >
  > {
    await this.ensureInitialized();
    const convoys = await this.listConvoys();
    const detailed = [];
    for (const convoy of convoys) {
      const status = await this.getConvoyStatus(convoy.id);
      detailed.push(status ?? { ...convoy, beads: [], dependency_edges: [] });
    }
    return detailed;
  }

  /**
   * Detailed convoy status with per-bead breakdown and DAG edges.
   */
  async getConvoyStatus(convoyId: string): Promise<
    | (ConvoyEntry & {
        beads: Array<{
          bead_id: string;
          title: string;
          status: string;
          rig_id: string | null;
          assignee_agent_name: string | null;
        }>;
        dependency_edges: Array<{
          bead_id: string;
          depends_on_bead_id: string;
        }>;
      })
    | null
  > {
    await this.ensureInitialized();
    const convoy = this.getConvoy(convoyId);
    if (!convoy) return null;

    // Fetch tracked beads with optional agent name.
    // Both sides of the LEFT JOIN are the beads table, so all column refs
    // must be qualified to avoid ambiguity.
    const trackedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${beads.bead_id}, ${beads.title}, ${beads.status},
                 ${beads.rig_id},
                 ${beads.assignee_agent_bead_id},
                 agent_beads.${beads.columns.title} AS assignee_agent_name
          FROM ${bead_dependencies}
          INNER JOIN ${beads} ON ${bead_dependencies.bead_id} = ${beads.bead_id}
          LEFT JOIN ${beads} AS agent_beads
            ON ${beads.assignee_agent_bead_id} = agent_beads.${beads.columns.bead_id}
          WHERE ${bead_dependencies.depends_on_bead_id} = ?
            AND ${bead_dependencies.dependency_type} = 'tracks'
          ORDER BY ${beads.created_at} ASC
        `,
        [convoyId]
      ),
    ];

    const TrackedBeadRow = z.object({
      bead_id: z.string(),
      title: z.string(),
      status: z.string(),
      rig_id: z.string().nullable(),
      assignee_agent_name: z.string().nullable(),
    });

    // Get DAG edges (blocks dependencies) between tracked beads
    const dependencyEdges = beadOps.getConvoyDependencyEdges(this.sql, convoyId);

    return {
      ...convoy,
      beads: trackedRows.map(row => TrackedBeadRow.parse(row)),
      dependency_edges: dependencyEdges,
    };
  }

  private getConvoy(convoyId: string): ConvoyEntry | null {
    const rows = [
      ...query(this.sql, /* sql */ `${CONVOY_JOIN} WHERE ${beads.bead_id} = ?`, [convoyId]),
    ];
    if (rows.length === 0) return null;
    return toConvoy(ConvoyBeadRecord.parse(rows[0]));
  }

  // ══════════════════════════════════════════════════════════════════
  // Escalations (beads with type='escalation' + escalation_metadata)
  // ══════════════════════════════════════════════════════════════════

  async acknowledgeEscalation(escalationId: string): Promise<EscalationEntry | null> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${escalation_metadata}
        SET ${escalation_metadata.columns.acknowledged} = 1, ${escalation_metadata.columns.acknowledged_at} = ?
        WHERE ${escalation_metadata.bead_id} = ? AND ${escalation_metadata.acknowledged} = 0
      `,
      [now(), escalationId]
    );
    return this.getEscalation(escalationId);
  }

  async listEscalations(filter?: { acknowledged?: boolean }): Promise<EscalationEntry[]> {
    await this.ensureInitialized();
    const rows =
      filter?.acknowledged !== undefined
        ? [
            ...query(
              this.sql,
              /* sql */ `${ESCALATION_JOIN} WHERE ${escalation_metadata.acknowledged} = ? ORDER BY ${beads.created_at} DESC LIMIT 100`,
              [filter.acknowledged ? 1 : 0]
            ),
          ]
        : [
            ...query(
              this.sql,
              /* sql */ `${ESCALATION_JOIN} ORDER BY ${beads.created_at} DESC LIMIT 100`,
              []
            ),
          ];
    return EscalationBeadRecord.array().parse(rows).map(toEscalation);
  }

  async routeEscalation(input: {
    townId: string;
    source_rig_id: string;
    source_agent_id?: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    category?: string;
    message: string;
  }): Promise<EscalationEntry> {
    await this.ensureInitialized();
    const beadId = generateId();
    const timestamp = now();

    // Resolve convoy context from the source agent's hooked bead so the
    // escalation is associated with the convoy for display and future
    // automated handling (Phase 4: convoy-aware triage).
    let convoyId: string | null = null;
    let sourceBeadId: string | null = null;
    if (input.source_agent_id) {
      const agent = agents.getAgent(this.sql, input.source_agent_id);
      if (agent?.current_hook_bead_id) {
        sourceBeadId = agent.current_hook_bead_id;
        convoyId = beadOps.getConvoyForBead(this.sql, sourceBeadId);
      }
    }

    const metadata: Record<string, unknown> = {};
    if (convoyId) metadata.convoy_id = convoyId;
    if (sourceBeadId) metadata.source_bead_id = sourceBeadId;

    // Create the escalation bead
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${beads} (
          ${beads.columns.bead_id}, ${beads.columns.type}, ${beads.columns.status},
          ${beads.columns.title}, ${beads.columns.body}, ${beads.columns.rig_id},
          ${beads.columns.parent_bead_id}, ${beads.columns.assignee_agent_bead_id},
          ${beads.columns.priority}, ${beads.columns.labels}, ${beads.columns.metadata},
          ${beads.columns.created_by}, ${beads.columns.created_at}, ${beads.columns.updated_at},
          ${beads.columns.closed_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        beadId,
        'escalation',
        'open',
        `Escalation: ${input.message.slice(0, 100)}`,
        input.message,
        input.source_rig_id,
        null,
        null,
        input.severity === 'critical' ? 'critical' : input.severity === 'high' ? 'high' : 'medium',
        JSON.stringify(['gt:escalation', `severity:${input.severity}`]),
        JSON.stringify(metadata),
        input.source_agent_id ?? null,
        timestamp,
        timestamp,
        null,
      ]
    );

    // Create escalation_metadata
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${escalation_metadata} (
          ${escalation_metadata.columns.bead_id}, ${escalation_metadata.columns.severity},
          ${escalation_metadata.columns.category}, ${escalation_metadata.columns.acknowledged},
          ${escalation_metadata.columns.re_escalation_count}, ${escalation_metadata.columns.acknowledged_at}
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [beadId, input.severity, input.category ?? null, 0, 0, null]
    );

    const escalation = this.getEscalation(beadId);
    if (!escalation) throw new Error('Failed to create escalation');

    // Create a triage request so the patrol→triage→resolve loop can
    // act on the escalation. Without this, escalation beads sit open
    // with no assignee and no automated follow-up.
    patrol.createTriageRequest(this.sql, {
      triageType: 'escalation',
      agentBeadId: input.source_agent_id ?? null,
      title: `Escalation (${input.severity}): ${input.message.slice(0, 80)}`,
      context: {
        escalation_bead_id: beadId,
        severity: input.severity,
        rig_id: input.source_rig_id,
        category: input.category,
        convoy_id: convoyId,
        source_bead_id: sourceBeadId,
      },
      options:
        input.severity === 'low'
          ? ['NUDGE', 'CLOSE_BEAD', 'PROVIDE_GUIDANCE']
          : ['ESCALATE_TO_MAYOR', 'RESTART', 'CLOSE_BEAD', 'REASSIGN_BEAD'],
      rigId: input.source_rig_id,
    });

    // Notify mayor directly for medium+ severity (in addition to triage)
    if (input.severity !== 'low') {
      this.sendMayorMessage(
        `[Escalation:${input.severity}] rig=${input.source_rig_id} ${input.message}`
      ).catch(err => {
        console.warn(`${TOWN_LOG} routeEscalation: failed to notify mayor:`, err);
        try {
          beadOps.logBeadEvent(this.sql, {
            beadId,
            agentId: input.source_agent_id ?? null,
            eventType: 'notification_failed',
            metadata: {
              target: 'mayor',
              reason: err instanceof Error ? err.message : String(err),
              severity: input.severity,
            },
          });
        } catch (logErr) {
          console.error(
            `${TOWN_LOG} routeEscalation: failed to log notification_failed event:`,
            logErr
          );
        }
      });
    }

    return escalation;
  }

  private getEscalation(escalationId: string): EscalationEntry | null {
    const rows = [
      ...query(this.sql, /* sql */ `${ESCALATION_JOIN} WHERE ${beads.bead_id} = ?`, [escalationId]),
    ];
    if (rows.length === 0) return null;
    return toEscalation(EscalationBeadRecord.parse(rows[0]));
  }

  // ══════════════════════════════════════════════════════════════════
  // Alarm (Scheduler + Witness Patrol + Review Queue)
  // ══════════════════════════════════════════════════════════════════

  async alarm(): Promise<void> {
    await this.ensureInitialized();
    const townId = this.townId;
    console.log(`${TOWN_LOG} alarm: fired for town=${townId}`);

    const hasRigs = rigs.listRigs(this.sql).length > 0;
    if (hasRigs) {
      try {
        await this.ensureContainerReady();
      } catch (err) {
        console.warn(`${TOWN_LOG} alarm: container health check failed`, err);
      }
    }

    // Refresh the container-scoped JWT before any work that might
    // trigger API calls. Throttled to once per hour (tokens have 8h
    // expiry, so hourly refresh provides ample safety margin).
    if (this.hasActiveWork()) {
      try {
        await this.refreshContainerToken();
      } catch (err) {
        console.warn(`${TOWN_LOG} alarm: refreshContainerToken failed`, err);
      }
    }

    // Process reviews FIRST so the refinery gets assigned before the
    // scheduler dispatches new polecats. This prevents downstream beads
    // from starting before upstream reviews are merged.
    try {
      await this.processReviewQueue();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: processReviewQueue failed`, err);
    }
    try {
      await this.processConvoyLandings();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: processConvoyLandings failed`, err);
    }
    try {
      await this.schedulePendingWork();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: schedulePendingWork failed`, err);
    }
    try {
      await this.witnessPatrol();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: witnessPatrol failed`, err);
    }
    try {
      this.deaconPatrol();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: deaconPatrol failed`, err);
    }
    try {
      await this.deliverPendingMail();
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: deliverPendingMail failed`, err);
    }
    try {
      await this.reEscalateStaleEscalations();
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: reEscalation failed`, err);
    }
    try {
      await this.maybeDispatchTriageAgent();
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: maybeDispatchTriageAgent failed`, err);
    }

    // Re-arm: fast when active, slow when idle
    const active = this.hasActiveWork();
    const interval = active ? ACTIVE_ALARM_INTERVAL_MS : IDLE_ALARM_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Date.now() + interval);

    // Broadcast status snapshot to connected WebSocket clients
    try {
      const snapshot = await this.getAlarmStatus();
      this.broadcastAlarmStatus(snapshot);
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: status broadcast failed`, err);
    }
  }

  /**
   * Push a fresh container-scoped JWT to the TownContainerDO. Called
   * from the alarm handler, throttled to once per hour (tokens have
   * 8h expiry). The TownContainerDO stores it as an env var so it's
   * available to all agents in the container.
   */
  private lastContainerTokenRefreshAt = 0;
  private async refreshContainerToken(): Promise<void> {
    const TOKEN_REFRESH_INTERVAL_MS = 60 * 60_000; // 1 hour
    const now = Date.now();
    if (now - this.lastContainerTokenRefreshAt < TOKEN_REFRESH_INTERVAL_MS) return;

    const townId = this.townId;
    if (!townId) return;
    const townConfig = await this.getTownConfig();
    const userId = townConfig.owner_user_id ?? townId;
    await dispatch.refreshContainerToken(this.env, townId, userId);
    // Only mark as refreshed after success — failed refreshes should
    // be retried on the next alarm tick, not throttled for an hour.
    this.lastContainerTokenRefreshAt = now;
  }

  private hasActiveWork(): boolean {
    const activeAgentRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata} WHERE ${agent_metadata.status} IN ('working', 'stalled')`,
        []
      ),
    ];
    const pendingBeadRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata} WHERE ${agent_metadata.status} = 'idle' AND ${agent_metadata.current_hook_bead_id} IS NOT NULL`,
        []
      ),
    ];
    const pendingReviewRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${beads} WHERE ${beads.type} = 'merge_request' AND ${beads.status} IN ('open', 'in_progress')`,
        []
      ),
    ];
    const pendingTriageRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${beads} WHERE ${beads.type} = 'issue' AND ${beads.labels} LIKE ? AND ${beads.status} = 'open'`,
        [patrol.TRIAGE_LABEL_LIKE]
      ),
    ];
    return (
      Number(activeAgentRows[0]?.cnt ?? 0) > 0 ||
      Number(pendingBeadRows[0]?.cnt ?? 0) > 0 ||
      Number(pendingReviewRows[0]?.cnt ?? 0) > 0 ||
      Number(pendingTriageRows[0]?.cnt ?? 0) > 0
    );
  }

  /**
   * Dispatch a single agent to the container. Used for eager dispatch from
   * slingBead (so agents start immediately) and from schedulePendingWork
   * (periodic recovery). Returns true if the agent was started.
   */
  private async dispatchAgent(agent: Agent, bead: Bead): Promise<boolean> {
    try {
      const rigId = agent.rig_id ?? rigs.listRigs(this.sql)[0]?.id ?? '';
      const rigConfig = rigId ? await this.getRigConfig(rigId) : null;
      if (!rigConfig) {
        console.warn(`${TOWN_LOG} dispatchAgent: no rig config for agent=${agent.id} rig=${rigId}`);
        return false;
      }

      const townConfig = await this.getTownConfig();
      const kilocodeToken = await this.resolveKilocodeToken();

      // Check if this bead belongs to a convoy and resolve its feature branch.
      // Convoy beads branch from the feature branch, not from defaultBranch.
      const convoyId = beadOps.getConvoyForBead(this.sql, bead.bead_id);
      const convoyFeatureBranch = convoyId
        ? beadOps.getConvoyFeatureBranch(this.sql, convoyId)
        : null;

      // Transition the bead to in_progress BEFORE starting the container.
      // This must happen synchronously within the DO's I/O gate — the
      // fire-and-forget pattern used by slingBead/slingConvoy means the
      // calling RPC may return before startAgentInContainer completes,
      // closing the I/O gate and preventing further SQL writes.
      const currentBead = beadOps.getBead(this.sql, bead.bead_id);
      if (
        currentBead &&
        currentBead.status !== 'in_progress' &&
        currentBead.status !== 'closed' &&
        currentBead.status !== 'failed'
      ) {
        beadOps.updateBeadStatus(this.sql, bead.bead_id, 'in_progress', agent.id);
      }

      // Set status to 'working' BEFORE the async container start. This
      // must happen synchronously so the SQL write executes while the I/O
      // gate is still open. When dispatchAgent is called fire-and-forget
      // (from slingBead, slingConvoy, dispatchUnblockedBeads), any SQL
      // writes after the first `await` may be silently dropped because
      // the DO's RPC response closes the I/O gate. If the container fails
      // to start, we roll back to 'idle'.
      const timestamp = now();
      query(
        this.sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.status} = 'working',
              ${agent_metadata.columns.dispatch_attempts} = ${agent_metadata.columns.dispatch_attempts} + 1,
              ${agent_metadata.columns.last_activity_at} = ?
          WHERE ${agent_metadata.bead_id} = ?
        `,
        [timestamp, agent.id]
      );

      const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
        townId: this.townId,
        rigId,
        userId: rigConfig.userId,
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        identity: agent.identity,
        beadId: bead.bead_id,
        beadTitle: bead.title,
        beadBody: bead.body ?? '',
        checkpoint: agent.checkpoint,
        gitUrl: rigConfig.gitUrl,
        defaultBranch: rigConfig.defaultBranch,
        kilocodeToken,
        townConfig,
        platformIntegrationId: rigConfig.platformIntegrationId,
        convoyFeatureBranch: convoyFeatureBranch ?? undefined,
      });

      if (started) {
        // Reset dispatch_attempts on success (best-effort — may be
        // dropped if the I/O gate is already closed, but that's fine
        // because the agent is already 'working').
        query(
          this.sql,
          /* sql */ `
            UPDATE ${agent_metadata}
            SET ${agent_metadata.columns.dispatch_attempts} = 0
            WHERE ${agent_metadata.bead_id} = ?
          `,
          [agent.id]
        );
        console.log(`${TOWN_LOG} dispatchAgent: started agent=${agent.name}(${agent.id})`);
      } else {
        // Container failed to start — roll back to idle
        query(
          this.sql,
          /* sql */ `
            UPDATE ${agent_metadata}
            SET ${agent_metadata.columns.status} = 'idle'
            WHERE ${agent_metadata.bead_id} = ?
          `,
          [agent.id]
        );
      }
      return started;
    } catch (err) {
      console.error(`${TOWN_LOG} dispatchAgent: failed for agent=${agent.id}:`, err);
      // Roll back agent and bead to prevent them from being stuck in
      // working/in_progress state when the container call throws.
      try {
        query(
          this.sql,
          /* sql */ `
            UPDATE ${agent_metadata}
            SET ${agent_metadata.columns.status} = 'idle'
            WHERE ${agent_metadata.bead_id} = ?
          `,
          [agent.id]
        );
        if (agent.current_hook_bead_id) {
          beadOps.updateBeadStatus(this.sql, agent.current_hook_bead_id, 'open', agent.id);
        }
      } catch (rollbackErr) {
        console.error(`${TOWN_LOG} dispatchAgent: rollback also failed:`, rollbackErr);
      }
      return false;
    }
  }

  /**
   * When a bead closes, find beads that were blocked by it and are now
   * fully unblocked (all 'blocks' dependencies resolved). Dispatch their
   * assigned agents.
   */
  private dispatchUnblockedBeads(closedBeadId: string): void {
    const unblockedIds = beadOps.getNewlyUnblockedBeads(this.sql, closedBeadId);
    if (unblockedIds.length === 0) return;

    console.log(
      `${TOWN_LOG} dispatchUnblockedBeads: ${unblockedIds.length} beads unblocked by ${closedBeadId}`
    );

    for (const beadId of unblockedIds) {
      const bead = beadOps.getBead(this.sql, beadId);
      if (!bead || bead.status === 'closed' || bead.status === 'failed') continue;

      // Find the agent hooked to this bead
      if (!bead.assignee_agent_bead_id) continue;
      const agent = agents.getAgent(this.sql, bead.assignee_agent_bead_id);
      if (!agent || agent.status !== 'idle') continue;

      this.dispatchAgent(agent, bead).catch(err =>
        console.error(
          `${TOWN_LOG} dispatchUnblockedBeads: fire-and-forget dispatch failed for bead=${beadId}`,
          err
        )
      );
    }
  }

  /**
   * Find idle agents with hooked beads and dispatch them to the container.
   * Agents whose last_activity_at is within the dispatch cooldown are
   * skipped — they have a fire-and-forget dispatch already in flight.
   */
  private async schedulePendingWork(): Promise<void> {
    const cooldownCutoff = new Date(Date.now() - DISPATCH_COOLDOWN_MS).toISOString();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${beads}.*,
                 ${agent_metadata.role}, ${agent_metadata.identity},
                 ${agent_metadata.container_process_id},
                 ${agent_metadata.status} AS status,
                 ${agent_metadata.current_hook_bead_id},
                 ${agent_metadata.dispatch_attempts}, ${agent_metadata.last_activity_at},
                 ${agent_metadata.checkpoint},
                 ${agent_metadata.agent_status_message}, ${agent_metadata.agent_status_updated_at}
          FROM ${beads}
          INNER JOIN ${agent_metadata} ON ${beads.bead_id} = ${agent_metadata.bead_id}
          WHERE ${agent_metadata.status} = 'idle'
            AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
            AND (${agent_metadata.last_activity_at} IS NULL OR ${agent_metadata.last_activity_at} < ?)
        `,
        [cooldownCutoff]
      ),
    ];
    const pendingAgents: Agent[] = AgentBeadRecord.array()
      .parse(rows)
      .map(row => ({
        id: row.bead_id,
        rig_id: row.rig_id,
        role: row.role,
        name: row.title,
        identity: row.identity,
        status: row.status,
        current_hook_bead_id: row.current_hook_bead_id,
        dispatch_attempts: row.dispatch_attempts,
        last_activity_at: row.last_activity_at,
        checkpoint: row.checkpoint,
        created_at: row.created_at,
        agent_status_message: row.agent_status_message,
        agent_status_updated_at: row.agent_status_updated_at,
      }));

    console.log(`${TOWN_LOG} schedulePendingWork: found ${pendingAgents.length} pending agents`);
    if (pendingAgents.length === 0) return;

    const dispatchTasks: Array<() => Promise<void>> = [];

    for (const agent of pendingAgents) {
      const beadId = agent.current_hook_bead_id;
      if (!beadId) continue;
      const bead = beadOps.getBead(this.sql, beadId);
      if (!bead) continue;

      if (agent.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
        beadOps.updateBeadStatus(this.sql, beadId, 'failed', agent.id);
        agents.unhookBead(this.sql, agent.id);
        continue;
      }

      // Skip beads that still have unresolved 'blocks' dependencies —
      // they'll be dispatched by dispatchUnblockedBeads when their
      // blockers close.
      if (beadOps.hasUnresolvedBlockers(this.sql, beadId)) {
        continue;
      }

      dispatchTasks.push(async () => {
        await this.dispatchAgent(agent, bead);
      });
    }

    if (dispatchTasks.length > 0) {
      await Promise.allSettled(dispatchTasks.map(fn => fn()));
    }
  }

  /**
   * Witness patrol: detect dead/stale agents, GUPP violations with
   * tiered escalation, orphaned work, agent GC, per-bead timeouts.
   *
   * Mechanical checks run as deterministic code. Ambiguous situations
   * produce triage_request beads for the on-demand triage agent.
   * See #442.
   */
  private async witnessPatrol(): Promise<void> {
    const townId = this.townId;

    // ── Zombie detection (container status reconciliation) ──────────
    const WorkingAgentRow = AgentMetadataRecord.pick({
      bead_id: true,
      current_hook_bead_id: true,
      last_activity_at: true,
    });
    const workingAgents = WorkingAgentRow.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agent_metadata.bead_id}, ${agent_metadata.current_hook_bead_id}, ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
          WHERE ${agent_metadata.status} IN ('working', 'stalled')
        `,
        []
      ),
    ]);

    for (const working of workingAgents) {
      const agentId = working.bead_id;

      const containerInfo = await dispatch.checkAgentContainerStatus(this.env, townId, agentId);

      if (containerInfo.status === 'not_found' || containerInfo.status === 'exited') {
        if (containerInfo.exitReason === 'completed') {
          reviewQueue.agentCompleted(this.sql, agentId, { status: 'completed' });
          continue;
        }
        query(
          this.sql,
          /* sql */ `
            UPDATE ${agent_metadata}
            SET ${agent_metadata.columns.status} = 'idle',
                ${agent_metadata.columns.last_activity_at} = ?
            WHERE ${agent_metadata.bead_id} = ?
          `,
          [now(), agentId]
        );
        continue;
      }
    }

    // ── Tiered GUPP violation handling ──────────────────────────────
    // Re-query to get the current set of working agents (some may have
    // been reset to idle by zombie detection above).
    const currentWorking = WorkingAgentRow.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agent_metadata.bead_id}, ${agent_metadata.current_hook_bead_id}, ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
          WHERE ${agent_metadata.status} IN ('working', 'stalled')
        `,
        []
      ),
    ]);

    const forceStopIds = patrol.detectGUPPViolations(this.sql, currentWorking);

    // Force-stop agents in the container (best-effort)
    for (const agentId of forceStopIds) {
      dispatch
        .stopAgentInContainer(this.env, townId, agentId)
        .catch(err =>
          console.warn(`${TOWN_LOG} witnessPatrol: force-stop failed for agent=${agentId}`, err)
        );
    }

    // ── Orphaned work detection ────────────────────────────────────
    patrol.detectOrphanedWork(this.sql);

    // ── Agent garbage collection ───────────────────────────────────
    const gcCount = patrol.agentGC(this.sql);
    if (gcCount > 0) {
      // Clean up AgentDO storage for GC'd agents (best-effort)
      console.log(`${TOWN_LOG} witnessPatrol: GC'd ${gcCount} agent(s)`);
    }

    // ── Per-bead timeout enforcement ───────────────────────────────
    const timedOut = patrol.checkTimerGates(this.sql);
    for (const { agentId } of timedOut) {
      if (agentId) {
        dispatch
          .stopAgentInContainer(this.env, townId, agentId)
          .catch(err =>
            console.warn(
              `${TOWN_LOG} witnessPatrol: failed to stop timed-out agent=${agentId}`,
              err
            )
          );
      }
    }
  }

  /**
   * Deacon patrol: stale hook detection, stranded convoy feeding,
   * crash loop detection.
   *
   * Mechanical checks that complement the witness patrol. See #442.
   */
  private deaconPatrol(): void {
    // ── Stale hook detection ───────────────────────────────────────
    patrol.detectStaleHooks(this.sql);

    // ── Stranded convoy feeding ────────────────────────────────────
    patrol.feedStrandedConvoys(this.sql, this.townId);

    // ── Crash loop detection ───────────────────────────────────────
    patrol.detectCrashLoops(this.sql);
  }

  /**
   * If triage_request beads are queued, dispatch a short-lived triage
   * agent to process them. The triage agent gets a focused prompt with
   * the pending requests and a narrow tool set.
   *
   * Skips dispatch if a triage agent is already working.
   */
  private async maybeDispatchTriageAgent(): Promise<void> {
    const pendingCount = patrol.countPendingTriageRequests(this.sql);
    if (pendingCount === 0) return;

    // Check if a triage batch bead is already in progress (meaning a
    // triage agent is working), or recently failed (cooldown to prevent
    // rapid retry loops). Skip dispatch in either case.
    const triageBatchLike = patrol.TRIAGE_LABEL_LIKE.replace(
      patrol.TRIAGE_REQUEST_LABEL,
      patrol.TRIAGE_BATCH_LABEL
    );
    const cooldownCutoff = new Date(Date.now() - DISPATCH_COOLDOWN_MS).toISOString();
    const existingBatch = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${beads.bead_id} FROM ${beads}
          WHERE ${beads.type} = 'issue'
            AND ${beads.labels} LIKE ?
            AND ${beads.created_by} = 'patrol'
            AND (
              ${beads.status} IN ('open', 'in_progress')
              OR (${beads.status} = 'failed' AND ${beads.updated_at} > ?)
            )
          LIMIT 1
        `,
        [triageBatchLike, cooldownCutoff]
      ),
    ];
    if (existingBatch.length > 0) {
      console.log(
        `${TOWN_LOG} maybeDispatchTriageAgent: triage batch bead active or in cooldown, skipping (${pendingCount} pending)`
      );
      return;
    }

    // Validate preconditions before creating any beads to avoid
    // leaked phantom issue beads on early-return paths.
    const rigList = rigs.listRigs(this.sql);
    if (rigList.length === 0) {
      console.warn(`${TOWN_LOG} maybeDispatchTriageAgent: no rigs available, skipping`);
      return;
    }
    const rigId = rigList[0].id;

    const rigConfig = await this.getRigConfig(rigId);
    if (!rigConfig) {
      console.warn(`${TOWN_LOG} maybeDispatchTriageAgent: no rig config for rig=${rigId}`);
      return;
    }

    console.log(
      `${TOWN_LOG} maybeDispatchTriageAgent: ${pendingCount} pending triage request(s), dispatching agent`
    );

    const townConfig = await this.getTownConfig();
    const kilocodeToken = await this.resolveKilocodeToken();

    // Build the triage prompt from pending requests
    const pendingRequests = patrol.listPendingTriageRequests(this.sql);
    const { buildTriageSystemPrompt } = await import('../prompts/triage-system.prompt');
    const systemPrompt = buildTriageSystemPrompt(pendingRequests);

    // Only now create the synthetic bead — preconditions are verified.
    const triageBead = beadOps.createBead(this.sql, {
      type: 'issue',
      title: `Triage batch: ${pendingCount} request(s)`,
      body: 'Process all pending triage request beads and resolve each one.',
      priority: 'high',
      labels: [patrol.TRIAGE_BATCH_LABEL],
      created_by: 'patrol',
    });

    const triageAgent = agents.getOrCreateAgent(this.sql, 'polecat', rigId, this.townId);
    agents.hookBead(this.sql, triageAgent.id, triageBead.bead_id);

    const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
      townId: this.townId,
      rigId,
      userId: rigConfig.userId,
      agentId: triageAgent.id,
      agentName: triageAgent.name,
      role: 'polecat',
      identity: triageAgent.identity,
      beadId: triageBead.bead_id,
      beadTitle: triageBead.title,
      beadBody: triageBead.body ?? '',
      checkpoint: null,
      gitUrl: rigConfig.gitUrl,
      defaultBranch: rigConfig.defaultBranch,
      kilocodeToken,
      townConfig,
      systemPromptOverride: systemPrompt,
      platformIntegrationId: rigConfig.platformIntegrationId,
      lightweight: true,
    });

    if (started) {
      // Mark the agent as working so the duplicate-guard on the next
      // alarm tick sees it and skips dispatch.
      agents.updateAgentStatus(this.sql, triageAgent.id, 'working');
    } else {
      agents.unhookBead(this.sql, triageAgent.id);
      // Failing the batch bead triggers cooldown: the guard at the top of
      // this method skips dispatch while a failed batch bead's updated_at
      // is within DISPATCH_COOLDOWN_MS.
      beadOps.updateBeadStatus(this.sql, triageBead.bead_id, 'failed', triageAgent.id);
      console.error(`${TOWN_LOG} maybeDispatchTriageAgent: triage agent failed to start`);
    }
  }

  /**
   * Push undelivered mail to agents that are currently running in the
   * container. For each working agent with open message beads, we format
   * the messages and send them as a follow-up prompt via the container's
   * /agents/:id/message endpoint. The mail is then marked as delivered so
   * it isn't sent again on the next alarm tick.
   */
  private async deliverPendingMail(): Promise<void> {
    const pendingByAgent = mail.getPendingMailForWorkingAgents(this.sql);
    if (pendingByAgent.size === 0) return;

    console.log(
      `${TOWN_LOG} deliverPendingMail: ${pendingByAgent.size} agent(s) with pending mail`
    );

    const deliveries = [...pendingByAgent.entries()].map(async ([agentId, messages]) => {
      const lines = messages.map(m => `[MAIL from ${m.from_agent_id}] ${m.subject}\n${m.body}`);
      const prompt = `You have ${messages.length} new mail message(s):\n\n${lines.join('\n\n---\n\n')}`;

      const sent = await dispatch.sendMessageToAgent(this.env, this.townId, agentId, prompt);

      if (sent) {
        // Mark delivered only after the container accepted the message
        mail.readAndDeliverMail(this.sql, agentId);
        console.log(
          `${TOWN_LOG} deliverPendingMail: delivered ${messages.length} message(s) to agent=${agentId}`
        );
      } else {
        console.warn(
          `${TOWN_LOG} deliverPendingMail: failed to push mail to agent=${agentId}, will retry next tick`
        );
      }
    });

    await Promise.allSettled(deliveries);
  }

  /**
   * Process the review queue: pop pending entries and trigger merge.
   */
  private async processReviewQueue(): Promise<void> {
    reviewQueue.recoverStuckReviews(this.sql);
    reviewQueue.closeOrphanedReviewBeads(this.sql);

    // Poll open PRs created by the 'pr' strategy
    await this.pollPendingPRs();

    const entry = reviewQueue.popReviewQueue(this.sql);
    if (!entry) return;

    // Resolve rig from the merge_request bead — not rigList[0] which would
    // pick the wrong rig in multi-rig towns.
    const rigId = entry.rig_id;
    if (!rigId) {
      console.error(`${TOWN_LOG} processReviewQueue: entry ${entry.id} has no rig_id, skipping`);
      reviewQueue.completeReview(this.sql, entry.id, 'failed');
      return;
    }
    const rigConfig = await this.getRigConfig(rigId);
    if (!rigConfig) {
      reviewQueue.completeReview(this.sql, entry.id, 'failed');
      return;
    }

    const townConfig = await this.getTownConfig();
    const mergeStrategy = config.resolveMergeStrategy(townConfig, rigConfig.merge_strategy);
    const gates = townConfig.refinery?.gates ?? [];

    // Resolve the target branch from review_metadata. For convoy beads
    // this will be the convoy's feature branch; for standalone beads it's
    // the rig's default branch. For convoy landing MRs it's back to default.
    const targetBranchRows = z
      .object({ target_branch: z.string() })
      .array()
      .parse([
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${review_metadata.target_branch}
            FROM ${review_metadata}
            WHERE ${review_metadata.bead_id} = ?
          `,
          [entry.id]
        ),
      ]);
    const targetBranch = targetBranchRows[0]?.target_branch ?? rigConfig.defaultBranch;

    // Check if this MR belongs to a convoy and what the merge mode is.
    // For 'review-then-land' convoys, the refinery only reviews and merges
    // into the feature branch (using direct strategy regardless of town config),
    // because the final land to main happens once ALL beads are done.
    // For 'review-and-merge' convoys (and standalone beads), use the normal strategy.
    const sourceBeadId = typeof entry.bead_id === 'string' ? entry.bead_id : null;
    const convoyId = sourceBeadId ? beadOps.getConvoyForBead(this.sql, sourceBeadId) : null;
    const convoyMergeMode = convoyId ? beadOps.getConvoyMergeMode(this.sql, convoyId) : null;

    // For review-then-land convoys targeting the feature branch, always use
    // direct merge strategy (the refinery merges the polecat's work into the
    // feature branch directly, no PR needed for intermediate steps).
    const isConvoyIntermediateMerge =
      convoyMergeMode === 'review-then-land' && targetBranch !== rigConfig.defaultBranch;
    const effectiveMergeStrategy = isConvoyIntermediateMerge ? 'direct' : mergeStrategy;

    console.log(
      `${TOWN_LOG} processReviewQueue: entry=${entry.id} branch=${entry.branch} ` +
        `targetBranch=${targetBranch} mergeStrategy=${effectiveMergeStrategy} ` +
        `convoyMode=${convoyMergeMode ?? 'standalone'} gates=${gates.length}`
    );

    // Get or create the per-rig refinery. If it already exists and is busy
    // (processing another review), put the entry back to 'open' so it gets
    // retried on the next alarm cycle.
    const refineryAgent = agents.getOrCreateAgent(this.sql, 'refinery', rigId, this.townId);
    if (refineryAgent.status !== 'idle') {
      console.log(
        `${TOWN_LOG} processReviewQueue: refinery for rig=${rigId} is ${refineryAgent.status}, re-queuing entry=${entry.id}`
      );
      beadOps.updateBeadStatus(this.sql, entry.id, 'open', 'system');
      return;
    }

    const { buildRefinerySystemPrompt } = await import('../prompts/refinery-system.prompt');
    const systemPrompt = buildRefinerySystemPrompt({
      identity: refineryAgent.identity,
      rigId,
      townId: this.townId,
      gates,
      branch: entry.branch,
      targetBranch,
      polecatAgentId: entry.agent_id,
      mergeStrategy: effectiveMergeStrategy,
      convoyContext: convoyMergeMode
        ? {
            mergeMode: convoyMergeMode,
            isIntermediateStep: isConvoyIntermediateMerge,
          }
        : undefined,
    });

    // Hook the refinery to the MR bead (entry.id), not the source bead
    // (entry.bead_id). The source bead stays closed with its original
    // polecat assignee preserved.
    agents.hookBead(this.sql, refineryAgent.id, entry.id);

    // Mark as working before the async container start (same I/O gate
    // rationale as dispatchAgent — see comment there).
    agents.updateAgentStatus(this.sql, refineryAgent.id, 'working');

    const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
      townId: this.townId,
      rigId,
      userId: rigConfig.userId,
      agentId: refineryAgent.id,
      agentName: refineryAgent.name,
      role: 'refinery',
      identity: refineryAgent.identity,
      beadId: entry.id,
      beadTitle: `Review merge: ${entry.branch} → ${targetBranch}`,
      beadBody: entry.summary ?? '',
      checkpoint: null,
      gitUrl: rigConfig.gitUrl,
      // Always clone from the rig's real default branch. The targetBranch
      // may be a convoy feature branch that doesn't exist on the remote yet.
      // The refinery's system prompt tells it which branch to merge into.
      defaultBranch: rigConfig.defaultBranch,
      kilocodeToken: rigConfig.kilocodeToken,
      townConfig,
      systemPromptOverride: systemPrompt,
      platformIntegrationId: rigConfig.platformIntegrationId,
    });

    if (!started) {
      agents.unhookBead(this.sql, refineryAgent.id);
      agents.updateAgentStatus(this.sql, refineryAgent.id, 'idle');
      console.error(
        `${TOWN_LOG} processReviewQueue: refinery agent failed to start for entry=${entry.id}`
      );
      reviewQueue.completeReview(this.sql, entry.id, 'failed');
    }
  }

  /**
   * Process convoys whose tracked beads are all closed and that have a
   * feature branch waiting to be landed. Creates a final merge_request bead
   * to merge the convoy's feature branch into the default branch.
   */
  private async processConvoyLandings(): Promise<void> {
    // Find convoys with ready_to_land flag in metadata that are still open
    const ReadyConvoyRow = z.object({
      bead_id: z.string(),
      metadata: z
        .string()
        .transform(v => {
          try {
            return JSON.parse(v) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .pipe(z.record(z.string(), z.any())),
    });
    const readyRows = ReadyConvoyRow.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${beads.bead_id}, ${beads.metadata}
          FROM ${beads}
          WHERE ${beads.type} = 'convoy'
            AND ${beads.status} = 'open'
            AND json_extract(${beads.metadata}, '$.ready_to_land') = 1
        `,
        []
      ),
    ]);

    for (const row of readyRows) {
      const convoyId = row.bead_id;
      const featureBranch = beadOps.getConvoyFeatureBranch(this.sql, convoyId);
      if (!featureBranch) continue;

      // Check if there's already a pending landing MR for this convoy
      const existingLanding = [
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${beads.bead_id}
            FROM ${beads}
            WHERE ${beads.type} = 'merge_request'
              AND ${beads.status} IN ('open', 'in_progress')
              AND json_extract(${beads.metadata}, '$.convoy_landing') = 1
              AND json_extract(${beads.metadata}, '$.convoy_id') = ?
            LIMIT 1
          `,
          [convoyId]
        ),
      ];
      if (existingLanding.length > 0) continue;

      // Find which rig this convoy's beads belong to
      const rigRow = z
        .object({ rig_id: z.string().nullable() })
        .array()
        .parse([
          ...query(
            this.sql,
            /* sql */ `
              SELECT ${beads.rig_id}
              FROM ${bead_dependencies}
              INNER JOIN ${beads} ON ${bead_dependencies.bead_id} = ${beads.bead_id}
              WHERE ${bead_dependencies.depends_on_bead_id} = ?
                AND ${bead_dependencies.dependency_type} = 'tracks'
                AND ${beads.rig_id} IS NOT NULL
              LIMIT 1
            `,
            [convoyId]
          ),
        ]);
      const rigId = rigRow[0]?.rig_id;
      if (!rigId) continue;

      const rigConfig = await this.getRigConfig(rigId);
      if (!rigConfig) continue;

      console.log(
        `${TOWN_LOG} processConvoyLandings: creating landing MR for convoy=${convoyId} branch=${featureBranch} → ${rigConfig.defaultBranch}`
      );

      // Submit a landing MR: feature branch → defaultBranch
      reviewQueue.submitToReviewQueue(this.sql, {
        agent_id: 'system',
        bead_id: convoyId,
        rig_id: rigId,
        branch: featureBranch,
        summary: `Landing convoy: merge ${featureBranch} → ${rigConfig.defaultBranch}`,
      });

      // Patch the just-created MR bead's metadata to mark it as a convoy landing
      // and set the target_branch to the default branch (not the convoy feature branch).
      const mrRows = z
        .object({ bead_id: z.string() })
        .array()
        .parse([
          ...query(
            this.sql,
            /* sql */ `
              SELECT ${beads.bead_id}
              FROM ${beads}
              WHERE ${beads.type} = 'merge_request'
                AND ${beads.created_by} = 'system'
                AND json_extract(${beads.metadata}, '$.source_bead_id') = ?
              ORDER BY ${beads.created_at} DESC
              LIMIT 1
            `,
            [convoyId]
          ),
        ]);
      if (mrRows.length > 0) {
        const mrBeadId = mrRows[0].bead_id;
        query(
          this.sql,
          /* sql */ `
            UPDATE ${beads}
            SET ${beads.columns.metadata} = json_set(
              COALESCE(${beads.metadata}, '{}'),
              '$.convoy_landing', 1,
              '$.convoy_id', ?
            )
            WHERE ${beads.bead_id} = ?
          `,
          [convoyId, mrBeadId]
        );
        // Override the target_branch to the default branch for the landing MR
        query(
          this.sql,
          /* sql */ `
            UPDATE ${review_metadata}
            SET ${review_metadata.columns.target_branch} = ?
            WHERE ${review_metadata.bead_id} = ?
          `,
          [rigConfig.defaultBranch, mrBeadId]
        );
      }

      // Clear the ready_to_land flag
      query(
        this.sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.metadata} = json_remove(COALESCE(${beads.metadata}, '{}'), '$.ready_to_land'),
              ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [now(), convoyId]
      );
    }
  }

  /**
   * Poll external PRs created by the 'pr' merge strategy.
   * Checks if PRs have been merged or closed and updates the MR bead status.
   */
  private async pollPendingPRs(): Promise<void> {
    const pendingReviews = reviewQueue.listPendingPRReviews(this.sql);
    if (pendingReviews.length === 0) return;

    console.log(`${TOWN_LOG} pollPendingPRs: checking ${pendingReviews.length} pending PR(s)`);

    const townConfig = await this.getTownConfig();

    // Cap the number of PRs polled per alarm tick to avoid exhausting
    // GitHub/GitLab API rate limits when many PRs are pending.
    const MAX_POLLS_PER_TICK = 10;
    for (const review of pendingReviews.slice(0, MAX_POLLS_PER_TICK)) {
      const prUrl = review.pr_url;
      if (!prUrl) continue;
      // review.bead_id is the MR bead's own ID (not the source bead).
      // MergeRequestBeadRecord.bead_id == the merge_request bead PK.

      try {
        const status = await this.checkPRStatus(prUrl, townConfig);
        console.log(
          `${TOWN_LOG} pollPendingPRs: entry=${review.bead_id} url=${prUrl} status=${status ?? 'null (could not determine)'}`
        );
        if (!status) continue;

        if (status === 'merged') {
          reviewQueue.completeReviewWithResult(this.sql, {
            entry_id: review.bead_id,
            status: 'merged',
            message: 'PR merged externally',
          });
          console.log(`${TOWN_LOG} pollPendingPRs: PR merged for entry=${review.bead_id}`);
        } else if (status === 'closed') {
          reviewQueue.completeReviewWithResult(this.sql, {
            entry_id: review.bead_id,
            status: 'failed',
            message: 'PR closed without merge',
          });
          console.log(
            `${TOWN_LOG} pollPendingPRs: PR closed without merge for entry=${review.bead_id}`
          );
        }
        // 'open' — still waiting, do nothing
      } catch (err) {
        console.warn(`${TOWN_LOG} pollPendingPRs: failed to check PR status for ${prUrl}:`, err);
      }
    }
  }

  /**
   * Check the status of a PR/MR via its URL.
   * Returns 'open', 'merged', or 'closed' (null if cannot determine).
   */
  private async checkPRStatus(
    prUrl: string,
    townConfig: TownConfig
  ): Promise<'open' | 'merged' | 'closed' | null> {
    // GitHub PR URL format: https://github.com/{owner}/{repo}/pull/{number}
    const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (ghMatch) {
      const [, owner, repo, numberStr] = ghMatch;
      const token = townConfig.git_auth.github_token;
      if (!token) {
        console.warn(`${TOWN_LOG} checkPRStatus: no github_token configured, cannot poll ${prUrl}`);
        return null;
      }

      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Gastown-Refinery/1.0',
          },
        }
      );
      if (!response.ok) {
        console.warn(
          `${TOWN_LOG} checkPRStatus: GitHub API returned ${response.status} for ${prUrl}`
        );
        return null;
      }

      const json = await response.json().catch(() => null);
      if (!json) return null;
      const data = GitHubPRStatusSchema.safeParse(json);
      if (!data.success) return null;

      if (data.data.merged) return 'merged';
      if (data.data.state === 'closed') return 'closed';
      return 'open';
    }

    // GitLab MR URL format: https://{host}/{path}/-/merge_requests/{iid}
    const glMatch = prUrl.match(/^(https:\/\/[^/]+)\/(.+)\/-\/merge_requests\/(\d+)/);
    if (glMatch) {
      const [, instanceUrl, projectPath, iidStr] = glMatch;
      const token = townConfig.git_auth.gitlab_token;
      if (!token) {
        console.warn(`${TOWN_LOG} checkPRStatus: no gitlab_token configured, cannot poll ${prUrl}`);
        return null;
      }

      // Validate the host against known GitLab hosts to prevent SSRF/token leak.
      // Only send the PRIVATE-TOKEN to gitlab.com or the configured instance URL.
      const prHost = new URL(instanceUrl).hostname;
      const configuredHost = townConfig.git_auth.gitlab_instance_url
        ? new URL(townConfig.git_auth.gitlab_instance_url).hostname
        : null;
      if (prHost !== 'gitlab.com' && prHost !== configuredHost) {
        console.warn(
          `${TOWN_LOG} checkPRStatus: refusing to send gitlab_token to unknown host: ${prHost}`
        );
        return null;
      }

      const encodedPath = encodeURIComponent(projectPath);
      const response = await fetch(
        `${instanceUrl}/api/v4/projects/${encodedPath}/merge_requests/${iidStr}`,
        {
          headers: { 'PRIVATE-TOKEN': token },
        }
      );
      if (!response.ok) {
        console.warn(
          `${TOWN_LOG} checkPRStatus: GitLab API returned ${response.status} for ${prUrl}`
        );
        return null;
      }

      const glJson = await response.json().catch(() => null);
      if (!glJson) return null;
      const data = GitLabMRStatusSchema.safeParse(glJson);
      if (!data.success) return null;

      if (data.data.state === 'merged') return 'merged';
      if (data.data.state === 'closed') return 'closed';
      return 'open';
    }

    console.warn(`${TOWN_LOG} checkPRStatus: unrecognized PR URL format: ${prUrl}`);
    return null;
  }

  /**
   * Bump severity of stale unacknowledged escalations.
   */
  private async reEscalateStaleEscalations(): Promise<void> {
    const candidates = [
      ...query(
        this.sql,
        /* sql */ `${ESCALATION_JOIN} WHERE ${escalation_metadata.acknowledged} = 0 AND ${escalation_metadata.re_escalation_count} < ?`,
        [MAX_RE_ESCALATIONS]
      ),
    ].map(r => toEscalation(EscalationBeadRecord.parse(r)));

    const nowMs = Date.now();
    for (const esc of candidates) {
      const ageMs = nowMs - new Date(esc.created_at).getTime();
      const requiredAgeMs = (esc.re_escalation_count + 1) * STALE_ESCALATION_THRESHOLD_MS;
      if (ageMs < requiredAgeMs) continue;

      const currentIdx = SEVERITY_ORDER.indexOf(esc.severity);
      if (currentIdx < 0 || currentIdx >= SEVERITY_ORDER.length - 1) continue;

      const newSeverity = SEVERITY_ORDER[currentIdx + 1];
      query(
        this.sql,
        /* sql */ `
          UPDATE ${escalation_metadata}
          SET ${escalation_metadata.columns.severity} = ?,
              ${escalation_metadata.columns.re_escalation_count} = ${escalation_metadata.columns.re_escalation_count} + 1
          WHERE ${escalation_metadata.bead_id} = ?
        `,
        [newSeverity, esc.id]
      );

      if (newSeverity !== 'low') {
        this.sendMayorMessage(
          `[Re-Escalation:${newSeverity}] rig=${esc.source_rig_id} ${esc.message}`
        ).catch(err => {
          console.warn(`${TOWN_LOG} re-escalation: failed to notify mayor:`, err);
          try {
            beadOps.logBeadEvent(this.sql, {
              beadId: esc.id,
              agentId: null,
              eventType: 'notification_failed',
              metadata: {
                target: 'mayor',
                reason: err instanceof Error ? err.message : String(err),
                severity: newSeverity,
                re_escalation: true,
              },
            });
          } catch (logErr) {
            console.error(
              `${TOWN_LOG} re-escalation: failed to log notification_failed event:`,
              logErr
            );
          }
        });
      }
    }
  }

  private async ensureContainerReady(): Promise<void> {
    const hasRigs = rigs.listRigs(this.sql).length > 0;
    if (!hasRigs) return;

    const hasWork = this.hasActiveWork();
    if (!hasWork) {
      const rigList = rigs.listRigs(this.sql);
      const newestRigAge = rigList.reduce((min, r) => {
        const age = Date.now() - new Date(r.created_at).getTime();
        return Math.min(min, age);
      }, Infinity);
      const isRecentlyConfigured = newestRigAge < 5 * 60_000;
      if (!isRecentlyConfigured) return;
    }

    const townId = this.townId;
    if (!townId) return;

    try {
      const container = getTownContainerStub(this.env, townId);
      await container.fetch('http://container/health');
    } catch {
      // Container is starting up or unavailable — alarm will retry
    }
  }

  // ── Alarm helpers ─────────────────────────────────────────────────

  private async armAlarmIfNeeded(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (!current || current < Date.now()) {
      await this.ctx.storage.setAlarm(Date.now() + ACTIVE_ALARM_INTERVAL_MS);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Cleanup
  // ══════════════════════════════════════════════════════════════════

  /**
   * Health check: verify the alarm is set and return basic town status.
   * Called by the GastownUserDO watchdog alarm to ensure each town's
   * alarm loop is firing. Re-arms the alarm if it's missing.
   */
  async healthCheck(): Promise<{
    townId: string;
    alarmSet: boolean;
    activeAgents: number;
    pendingBeads: number;
  }> {
    await this.ensureInitialized();
    const townId = this.townId;

    // Check if alarm is set
    const currentAlarm = await this.ctx.storage.getAlarm();
    const alarmSet = currentAlarm !== null && currentAlarm > Date.now();

    // Re-arm if missing — this is the whole point of the watchdog
    if (!alarmSet) {
      console.warn(`${TOWN_LOG} healthCheck: alarm not set for town=${townId}, re-arming`);
      await this.ctx.storage.setAlarm(Date.now() + ACTIVE_ALARM_INTERVAL_MS);
    }

    const activeAgents = Number(
      [
        ...query(
          this.sql,
          /* sql */ `SELECT COUNT(*) AS cnt FROM ${agent_metadata} WHERE ${agent_metadata.status} IN ('working', 'stalled')`,
          []
        ),
      ][0]?.cnt ?? 0
    );

    const pendingBeads = Number(
      [
        ...query(
          this.sql,
          /* sql */ `SELECT COUNT(*) AS cnt FROM ${beads} WHERE ${beads.status} IN ('open', 'in_progress', 'in_review') AND ${beads.type} NOT IN ('agent', 'message')`,
          []
        ),
      ][0]?.cnt ?? 0
    );

    return { townId, alarmSet, activeAgents, pendingBeads };
  }

  /**
   * Return a structured snapshot of the alarm loop and patrol state
   * for the dashboard Status tab.
   */
  async getAlarmStatus(): Promise<{
    alarm: {
      nextFireAt: string | null;
      intervalMs: number;
      intervalLabel: string;
    };
    agents: {
      working: number;
      idle: number;
      stalled: number;
      dead: number;
      total: number;
    };
    beads: {
      open: number;
      inProgress: number;
      inReview: number;
      failed: number;
      triageRequests: number;
    };
    patrol: {
      guppWarnings: number;
      guppEscalations: number;
      stalledAgents: number;
      orphanedHooks: number;
    };
    recentEvents: Array<{
      time: string;
      type: string;
      message: string;
    }>;
  }> {
    await this.ensureInitialized();

    const currentAlarm = await this.ctx.storage.getAlarm();
    const active = this.hasActiveWork();
    const intervalMs = active ? ACTIVE_ALARM_INTERVAL_MS : IDLE_ALARM_INTERVAL_MS;

    // Agent counts by status
    const agentRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agent_metadata.status} AS status, COUNT(*) AS cnt
          FROM ${agent_metadata}
          GROUP BY ${agent_metadata.status}
        `,
        []
      ),
    ];
    const agentCounts = { working: 0, idle: 0, stalled: 0, dead: 0, total: 0 };
    for (const row of agentRows) {
      const s = `${row.status as string}`;
      const c = Number(row.cnt);
      if (s in agentCounts) (agentCounts as Record<string, number>)[s] = c;
      agentCounts.total += c;
    }

    // Bead counts
    const beadRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${beads.status} AS status, COUNT(*) AS cnt
          FROM ${beads}
          WHERE ${beads.type} NOT IN ('agent', 'message')
          GROUP BY ${beads.status}
        `,
        []
      ),
    ];
    const beadCounts = { open: 0, inProgress: 0, inReview: 0, failed: 0, triageRequests: 0 };
    for (const row of beadRows) {
      const s = `${row.status as string}`;
      const c = Number(row.cnt);
      if (s === 'open') beadCounts.open = c;
      else if (s === 'in_progress') beadCounts.inProgress = c;
      else if (s === 'in_review') beadCounts.inReview = c;
      else if (s === 'failed') beadCounts.failed = c;
    }

    // Triage request count (issue beads with gt:triage-request label)
    beadCounts.triageRequests = patrol.countPendingTriageRequests(this.sql);

    // Patrol indicators — count active warnings/issues
    const guppWarnings = Number(
      [
        ...query(
          this.sql,
          /* sql */ `
            SELECT COUNT(*) AS cnt FROM ${beads}
            WHERE ${beads.type} = 'message'
              AND ${beads.title} = 'GUPP_CHECK'
              AND ${beads.status} = 'open'
          `,
          []
        ),
      ][0]?.cnt ?? 0
    );

    const guppEscalations = Number(
      [
        ...query(
          this.sql,
          /* sql */ `
            SELECT COUNT(*) AS cnt FROM ${beads}
            WHERE ${beads.type} = 'message'
              AND ${beads.title} = 'GUPP_ESCALATION'
              AND ${beads.status} = 'open'
          `,
          []
        ),
      ][0]?.cnt ?? 0
    );

    const stalledAgents = agentCounts.stalled;

    // Only count idle+hooked agents as orphaned if they've been idle for
    // longer than the dispatch cooldown. Agents that were just hooked by
    // feedStrandedConvoys or restarted with backoff are legitimately
    // waiting for the next scheduler tick.
    const orphanedHooks = Number(
      [
        ...query(
          this.sql,
          /* sql */ `
            SELECT COUNT(*) AS cnt FROM ${agent_metadata}
            WHERE ${agent_metadata.status} = 'idle'
              AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
              AND (
                ${agent_metadata.last_activity_at} IS NULL
                OR ${agent_metadata.last_activity_at} < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
              )
          `,
          []
        ),
      ][0]?.cnt ?? 0
    );

    // Recent bead events (last 20) for the activity feed
    const recentRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT be.created_at, be.event_type, be.new_value, be.agent_id, be.bead_id,
                 b.${beads.columns.title} AS bead_title
          FROM bead_events AS be
          LEFT JOIN ${beads} AS b ON be.bead_id = b.${beads.columns.bead_id}
          ORDER BY be.created_at DESC
          LIMIT 20
        `,
        []
      ),
    ];

    const recentEvents = recentRows.map(row => ({
      time: `${row.created_at as string}`,
      type: `${row.event_type as string}`,
      message: formatEventMessage(row),
    }));

    return {
      alarm: {
        nextFireAt: currentAlarm ? new Date(Number(currentAlarm)).toISOString() : null,
        intervalMs,
        intervalLabel: active ? 'active (5s)' : 'idle (60s)',
      },
      agents: agentCounts,
      beads: beadCounts,
      patrol: {
        guppWarnings,
        guppEscalations,
        stalledAgents,
        orphanedHooks,
      },
      recentEvents,
    };
  }

  async destroy(): Promise<void> {
    console.log(`${TOWN_LOG} destroy: clearing all storage and alarms`);

    try {
      const allAgents = agents.listAgents(this.sql);
      await Promise.allSettled(
        allAgents.map(agent => getAgentDOStub(this.env, agent.id).destroy())
      );
    } catch {
      // Best-effort
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export function getTownDOStub(env: Env, townId: string) {
  return env.TOWN.get(env.TOWN.idFromName(townId));
}
