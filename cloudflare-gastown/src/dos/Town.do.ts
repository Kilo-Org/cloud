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
import * as Sentry from '@sentry/cloudflare';
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
import * as scheduling from './town/scheduling';
import * as events from './town/events';
import * as reconciler from './town/reconciler';
import { applyAction } from './town/actions';
import type { Action, ApplyActionContext } from './town/actions';
import { buildRefinerySystemPrompt } from '../prompts/refinery-system.prompt';
import { GitHubPRStatusSchema, GitLabMRStatusSchema } from '../util/platform-pr.util';

// Table imports for beads-centric operations
import {
  beads,
  BeadRecord,
  EscalationBeadRecord,
  ConvoyBeadRecord,
} from '../db/tables/beads.table';
import { agent_metadata, AgentMetadataRecord } from '../db/tables/agent-metadata.table';
import { review_metadata } from '../db/tables/review-metadata.table';
import { escalation_metadata } from '../db/tables/escalation-metadata.table';
import { convoy_metadata } from '../db/tables/convoy-metadata.table';
import { bead_dependencies } from '../db/tables/bead-dependencies.table';
import { town_events, TownEventRecord } from '../db/tables/town-events.table';
import {
  agent_nudges,
  AgentNudgeRecord,
  createTableAgentNudges,
  getIndexesAgentNudges,
} from '../db/tables/agent-nudges.table';
import { query } from '../util/query.util';
import { getAgentDOStub } from './Agent.do';
import { getTownContainerStub } from './TownContainer.do';

import { writeEvent, type GastownEventData } from '../util/analytics.util';
import { logger, withLogTags } from '../util/log.util';
import { BeadPriority } from '../types';
import type {
  TownConfig,
  TownConfigUpdate,
  CreateBeadInput,
  BeadFilter,
  Bead,
  BeadStatus,
  BeadPriority as BeadPriorityType,
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
  ConvoyMergeMode,
  UiAction,
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
  staged: boolean;
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
    staged: row.staged === 1,
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
         ${convoy_metadata.merge_mode}, ${convoy_metadata.staged}
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
  private _ownerUserId: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      await this.ensureInitialized();
    });
  }

  private emitEvent(data: Omit<GastownEventData, 'userId' | 'delivery'>): void {
    writeEvent(this.env, {
      ...data,
      delivery: 'internal',
      userId: this._ownerUserId,
    });
  }

  /** Build the context object used by the scheduling sub-module. */
  private get schedulingCtx(): Parameters<typeof scheduling.dispatchAgent>[0] {
    return {
      sql: this.sql,
      env: this.env,
      storage: this.ctx.storage,
      townId: this.townId,
      getTownConfig: () => this.getTownConfig(),
      getRigConfig: (rigId: string) => this.getRigConfig(rigId),
      resolveKilocodeToken: () => this.resolveKilocodeToken(),
      emitEvent: data => this.emitEvent(data),
    };
  }

  /** Build the context object used by the reconciler's applyAction. */
  private get applyActionCtx(): ApplyActionContext {
    const schedulingCtx = this.schedulingCtx;
    return {
      sql: this.sql,
      townId: this.townId,
      dispatchAgent: async (agentId, beadId, rigId) => {
        const agent = agents.getAgent(this.sql, agentId);
        const bead = beadOps.getBead(this.sql, beadId);
        if (!agent || !bead) return false;

        // Build refinery-specific system prompt with branch/target info
        let systemPromptOverride: string | undefined;
        if (agent.role === 'refinery' && bead.type === 'merge_request') {
          const reviewMeta = reviewQueue.getReviewMetadata(this.sql, beadId);
          const sourceBeadId =
            typeof bead.metadata?.source_bead_id === 'string' ? bead.metadata.source_bead_id : null;
          const townConfig = await this.getTownConfig();
          systemPromptOverride = buildRefinerySystemPrompt({
            identity: agent.identity,
            rigId,
            townId: this.townId,
            gates: townConfig.refinery?.gates ?? [],
            branch: reviewMeta?.branch ?? 'unknown',
            targetBranch: reviewMeta?.target_branch ?? 'main',
            polecatAgentId:
              typeof bead.metadata?.source_agent_id === 'string'
                ? bead.metadata.source_agent_id
                : 'unknown',
            mergeStrategy: townConfig.merge_strategy ?? 'direct',
          });
        }

        return scheduling.dispatchAgent(schedulingCtx, agent, bead, {
          systemPromptOverride,
        });
      },
      stopAgent: async agentId => {
        await dispatch.stopAgentInContainer(this.env, this.townId, agentId);
      },
      checkPRStatus: async prUrl => {
        const townConfig = await this.getTownConfig();
        return this.checkPRStatus(prUrl, townConfig);
      },
      queueNudge: async (agentId, message, _tier) => {
        await this.queueNudge(agentId, message, {
          mode: 'immediate',
          priority: 'urgent',
          source: 'reconciler',
        });
      },
      insertEvent: (eventType, params) => {
        events.insertEvent(this.sql, eventType as Parameters<typeof events.insertEvent>[1], params);
      },
      emitEvent: data => {
        if (typeof data.event === 'string') {
          this.emitEvent(data as Parameters<typeof this.emitEvent>[0]);
        }
      },
    };
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

  /**
   * Broadcast an incremental bead lifecycle event to all connected status
   * WebSocket clients. Called after bead create/update/close operations.
   */
  private broadcastBeadEvent(event: {
    type: 'bead.created' | 'bead.status_changed' | 'bead.closed' | 'bead.failed';
    beadId: string;
    title?: string;
    status?: string;
    rigId?: string;
    convoyId?: string;
  }): void {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;
    const frame = JSON.stringify({ channel: 'bead', ...event, ts: now() });
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  /**
   * Broadcast convoy progress to all connected status WebSocket clients.
   * Called from onBeadClosed() after updating closed_beads count.
   */
  private broadcastConvoyProgress(convoyId: string, totalBeads: number, closedBeads: number): void {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;
    const frame = JSON.stringify({
      channel: 'convoy',
      convoyId,
      totalBeads,
      closedBeads,
      ts: now(),
    });
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  /**
   * Broadcast a ui_action event to all connected status WebSocket clients.
   * Called by the mayor via the /mayor/ui-action HTTP route.
   */
  async broadcastUiAction(action: UiAction): Promise<void> {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;
    const frame = JSON.stringify({ channel: 'ui_action', action, ts: now() });
    for (const ws of sockets) {
      try {
        ws.send(frame);
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

    // Cache owner_user_id for analytics events
    const townConfig = await config.getTownConfig(this.ctx.storage);
    this._ownerUserId = townConfig.owner_user_id;

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

    // Nudges
    query(this.sql, createTableAgentNudges(), []);
    for (const idx of getIndexesAgentNudges()) {
      query(this.sql, idx, []);
    }

    // Reconciler event log
    events.initTownEventsTable(this.sql);

    // Ensure the alarm loop is running. After a deploy/restart, the
    // Cloudflare runtime normally delivers missed alarms, but if the alarm
    // was never set or was deleted by destroy(), the loop is dead. Re-arm
    // unconditionally so pending work (idle agents with hooks, open MR beads,
    // stale reviews) gets processed.
    await this.armAlarmIfNeeded();
  }

  private _townId: string | null = null;
  private _lastReconcilerMetrics: reconciler.ReconcilerMetrics | null = null;
  private _dashboardContext: string | null = null;

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

  async setDashboardContext(context: string): Promise<void> {
    this._dashboardContext = context;
    // Best-effort push to the running container so the plugin has it
    // in-memory for the next LLM call without a network round-trip.
    await dispatch.pushDashboardContext(this.env, this.townId, context);
  }

  async getDashboardContext(): Promise<string | null> {
    return this._dashboardContext;
  }

  // ══════════════════════════════════════════════════════════════════
  // Town Configuration
  // ══════════════════════════════════════════════════════════════════

  async getTownConfig(): Promise<TownConfig> {
    return config.getTownConfig(this.ctx.storage);
  }

  async updateTownConfig(update: TownConfigUpdate): Promise<TownConfig> {
    const result = await config.updateTownConfig(this.ctx.storage, update);
    this._ownerUserId = result.owner_user_id;
    return result;
  }

  /**
   * Force-refresh the container token, bypassing the 1-hour throttle.
   * Called from the user-facing tRPC mutation so operators can manually
   * push a fresh JWT to the running container.
   *
   * Unlike the alarm-driven refreshContainerToken, this propagates ALL
   * errors (including container-down) so the UI can show a real failure
   * instead of a false success.
   */
  async forceRefreshContainerToken(): Promise<void> {
    const townId = this.townId;
    if (!townId) throw new Error('townId not set');
    const townConfig = await this.getTownConfig();
    const userId = townConfig.owner_user_id ?? townId;
    await dispatch.forceRefreshContainerToken(this.env, townId, userId);
    this.lastContainerTokenRefreshAt = Date.now();
  }

  /**
   * Push config-derived env vars to the running container. Called after
   * updateTownConfig so that settings changes take effect without a
   * container restart. New agent processes inherit the updated values.
   */
  async syncConfigToContainer(): Promise<void> {
    const townId = this.townId;
    if (!townId) return;
    const townConfig = await this.getTownConfig();
    const container = getTownContainerStub(this.env, townId);

    // Map config fields to their container env var equivalents.
    // When a value is set, push it; when cleared, remove it.
    const envMapping: Array<[string, string | undefined]> = [
      ['GIT_TOKEN', townConfig.git_auth?.github_token],
      ['GITLAB_TOKEN', townConfig.git_auth?.gitlab_token],
      ['GITLAB_INSTANCE_URL', townConfig.git_auth?.gitlab_instance_url],
      ['GITHUB_CLI_PAT', townConfig.github_cli_pat],
      ['GASTOWN_GIT_AUTHOR_NAME', townConfig.git_author_name],
      ['GASTOWN_GIT_AUTHOR_EMAIL', townConfig.git_author_email],
      ['GASTOWN_DISABLE_AI_COAUTHOR', townConfig.disable_ai_coauthor ? '1' : undefined],
    ];

    for (const [key, value] of envMapping) {
      try {
        if (value) {
          await container.setEnvVar(key, value);
        } else {
          await container.deleteEnvVar(key);
        }
      } catch (err) {
        console.warn(`[Town.do] syncConfigToContainer: ${key} sync failed:`, err);
      }
    }
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
    return rigs.addRig(this.sql, input);
  }

  async removeRig(rigId: string): Promise<void> {
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
    return rigs.listRigs(this.sql);
  }

  async getRigAsync(rigId: string): Promise<rigs.RigRecord | null> {
    return rigs.getRig(this.sql, rigId);
  }

  // ── Rig Config (KV, per-rig — configuration needed for container dispatch) ──

  async configureRig(rigConfig: RigConfig): Promise<void> {
    return withLogTags({ source: 'Town.do', tags: { townId: this.townId } }, () =>
      this._configureRig(rigConfig)
    );
  }

  private async _configureRig(rigConfig: RigConfig): Promise<void> {
    logger.setTags({ rigId: rigConfig.rigId, userId: rigConfig.userId });
    logger.info('configureRig: start', { hasKilocodeToken: !!rigConfig.kilocodeToken });
    await this.ctx.storage.put(`rig:${rigConfig.rigId}:config`, rigConfig);

    if (rigConfig.kilocodeToken) {
      const townConfig = await this.getTownConfig();
      if (!townConfig.kilocode_token || townConfig.kilocode_token !== rigConfig.kilocodeToken) {
        logger.info('configureRig: propagating kilocodeToken to town config');
        await this.updateTownConfig({
          kilocode_token: rigConfig.kilocodeToken,
        });
      }
    }

    const token = rigConfig.kilocodeToken ?? (await this.resolveKilocodeToken());
    if (token) {
      try {
        const container = getTownContainerStub(this.env, this.townId);
        await container.setEnvVar('KILOCODE_TOKEN', token);
        logger.info('configureRig: stored KILOCODE_TOKEN on TownContainerDO');
      } catch (err) {
        logger.warn('configureRig: failed to store token on container DO', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('configureRig: proactively starting container');
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
      logger.warn('configureRig: background repo setup failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }

  /**
   * Tell the container to clone a rig's repo and create a browse worktree.
   * Fire-and-forget — failures are logged but don't block the caller.
   */
  private async setupRigRepoInContainer(rigConfig: RigConfig): Promise<void> {
    logger.setTags({ rigId: rigConfig.rigId });
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
      logger.warn('setupRigRepoInContainer: failed', {
        status: response.status,
        body: text.slice(0, 200),
      });
    } else {
      logger.info('setupRigRepoInContainer: accepted');
    }
  }

  async getRigConfig(rigId: string): Promise<RigConfig | null> {
    return (await this.ctx.storage.get<RigConfig>(`rig:${rigId}:config`)) ?? null;
  }

  // ══════════════════════════════════════════════════════════════════
  // Beads
  // ══════════════════════════════════════════════════════════════════

  async createBead(input: CreateBeadInput): Promise<Bead> {
    const bead = beadOps.createBead(this.sql, input);
    this.emitEvent({
      event: 'bead.created',
      townId: this.townId,
      rigId: input.rig_id,
      beadId: bead.bead_id,
      beadType: input.type,
    });
    this.broadcastBeadEvent({
      type: 'bead.created',
      beadId: bead.bead_id,
      title: bead.title,
      status: bead.status,
      rigId: bead.rig_id ?? undefined,
    });
    return bead;
  }

  async getBeadAsync(beadId: string): Promise<Bead | null> {
    return beadOps.getBead(this.sql, beadId);
  }

  async listBeads(filter: BeadFilter): Promise<Bead[]> {
    return beadOps.listBeads(this.sql, filter);
  }

  async updateBeadStatus(beadId: string, status: string, agentId: string): Promise<Bead> {
    // Record terminal transitions as bead_cancelled events for the reconciler.
    // Non-terminal transitions are normal lifecycle changes, not cancellations.
    if (status === 'closed' || status === 'failed') {
      events.insertEvent(this.sql, 'bead_cancelled', {
        bead_id: beadId,
        payload: { cancel_status: status },
      });
    }

    // Convoy progress is updated automatically inside beadOps.updateBeadStatus
    // when the bead reaches a terminal status (closed/failed).
    const bead = beadOps.updateBeadStatus(this.sql, beadId, status, agentId);

    if (status === 'closed') {
      const durationMs = Date.now() - new Date(bead.created_at).getTime();
      this.emitEvent({
        event: 'bead.closed',
        townId: this.townId,
        rigId: bead.rig_id ?? undefined,
        beadId,
        beadType: bead.type,
        durationMs,
      });
      this.broadcastBeadEvent({
        type: 'bead.closed',
        beadId,
        title: bead.title,
        status: 'closed',
        rigId: bead.rig_id ?? undefined,
      });
      // When a bead closes, check if any blocked beads are now unblocked and dispatch them.
      this.dispatchUnblockedBeads(beadId);
    } else if (status === 'failed') {
      this.emitEvent({
        event: 'bead.failed',
        townId: this.townId,
        rigId: bead.rig_id ?? undefined,
        beadId,
        beadType: bead.type,
      });
      this.broadcastBeadEvent({
        type: 'bead.failed',
        beadId,
        title: bead.title,
        status: 'failed',
        rigId: bead.rig_id ?? undefined,
      });
      this.dispatchUnblockedBeads(beadId);
    } else {
      this.emitEvent({
        event: 'bead.status_changed',
        townId: this.townId,
        rigId: bead.rig_id ?? undefined,
        beadId,
        beadType: bead.type,
        label: status,
      });
      this.broadcastBeadEvent({
        type: 'bead.status_changed',
        beadId,
        title: bead.title,
        status,
        rigId: bead.rig_id ?? undefined,
      });
    }

    return bead;
  }

  async closeBead(beadId: string, agentId: string): Promise<Bead> {
    return this.updateBeadStatus(beadId, 'closed', agentId);
  }

  async deleteBead(beadId: string): Promise<void> {
    beadOps.deleteBead(this.sql, beadId);
  }

  async listBeadEvents(options: {
    beadId?: string;
    since?: string;
    limit?: number;
  }): Promise<BeadEventRecord[]> {
    return beadOps.listBeadEvents(this.sql, options);
  }

  /**
   * Partially update a bead's editable fields.
   * Only fields explicitly provided are updated (partial update semantics).
   * Writes a `fields_updated` bead_event for auditability.
   */
  async updateBead(
    beadId: string,
    fields: Partial<{
      title: string;
      body: string | null;
      priority: BeadPriorityType;
      labels: string[];
      status: BeadStatus;
      metadata: Record<string, unknown>;
    }>,
    actorId: string
  ): Promise<Bead> {
    const bead = beadOps.updateBeadFields(this.sql, beadId, fields, actorId);

    // When a bead closes via field update, check for newly unblocked beads
    if (fields.status === 'closed' || fields.status === 'failed') {
      this.dispatchUnblockedBeads(beadId);
    }

    return bead;
  }

  /**
   * Force-reset an agent to idle, unhooking from its current bead if any.
   * Sets the bead status back to 'open' so it can be re-dispatched.
   * Writes a bead_event for auditability.
   */
  async resetAgent(agentId: string): Promise<void> {
    const agent = agents.getAgent(this.sql, agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const hookedBeadId = agent.current_hook_bead_id;

    if (hookedBeadId) {
      // Return the bead to 'open' so the scheduler can re-assign it
      const bead = beadOps.getBead(this.sql, hookedBeadId);
      if (bead && bead.status !== 'closed' && bead.status !== 'failed') {
        beadOps.updateBeadStatus(this.sql, hookedBeadId, 'open', agentId);
      }

      beadOps.logBeadEvent(this.sql, {
        beadId: hookedBeadId,
        agentId,
        eventType: 'unhooked',
        newValue: 'open',
        metadata: { reason: 'agent_reset', actor: 'mayor' },
      });

      agents.unhookBead(this.sql, agentId);
    }

    agents.updateAgentStatus(this.sql, agentId, 'idle');

    console.log(
      `${TOWN_LOG} resetAgent: reset agent=${agentId} hookedBead=${hookedBeadId ?? 'none'}`
    );
  }

  /**
   * Edit convoy_metadata fields (merge_mode, feature_branch).
   * Returns the updated convoy, or null if not found.
   */
  async updateConvoy(
    convoyId: string,
    fields: Partial<{ merge_mode: ConvoyMergeMode; feature_branch: string }>
  ): Promise<ConvoyEntry | null> {
    const convoy = this.getConvoy(convoyId);
    if (!convoy) return null;

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (fields.merge_mode !== undefined) {
      setClauses.push(`${convoy_metadata.columns.merge_mode} = ?`);
      values.push(fields.merge_mode);
    }
    if (fields.feature_branch !== undefined) {
      setClauses.push(`${convoy_metadata.columns.feature_branch} = ?`);
      values.push(fields.feature_branch);
    }

    if (setClauses.length > 0) {
      values.push(convoyId);
      // Dynamic SET clause — query() can't statically verify param count here,
      // so use sql.exec() directly. The guard above guarantees values is non-empty.
      this.sql.exec(
        /* sql */ `UPDATE ${convoy_metadata} SET ${setClauses.join(', ')} WHERE ${convoy_metadata.bead_id} = ?`,
        ...values
      );

      // Also update the convoy bead's updated_at
      query(
        this.sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [now(), convoyId]
      );
    }

    return this.getConvoy(convoyId);
  }

  // ══════════════════════════════════════════════════════════════════
  // Agents
  // ══════════════════════════════════════════════════════════════════

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    return agents.registerAgent(this.sql, input);
  }

  async getAgentAsync(agentId: string): Promise<Agent | null> {
    return agents.getAgent(this.sql, agentId);
  }

  async getAgentByIdentity(identity: string): Promise<Agent | null> {
    return agents.getAgentByIdentity(this.sql, identity);
  }

  async listAgents(filter?: AgentFilter): Promise<Agent[]> {
    return agents.listAgents(this.sql, filter);
  }

  async updateAgentStatus(agentId: string, status: string): Promise<void> {
    agents.updateAgentStatus(this.sql, agentId, status);
  }

  async deleteAgent(agentId: string): Promise<void> {
    agents.deleteAgent(this.sql, agentId);
    try {
      const agentDO = getAgentDOStub(this.env, agentId);
      await agentDO.destroy();
    } catch {
      // Best-effort
    }
  }

  async hookBead(agentId: string, beadId: string): Promise<void> {
    agents.hookBead(this.sql, agentId, beadId);
    await this.armAlarmIfNeeded();
  }

  async unhookBead(agentId: string): Promise<void> {
    agents.unhookBead(this.sql, agentId);
  }

  async getHookedBead(agentId: string): Promise<Bead | null> {
    return agents.getHookedBead(this.sql, agentId);
  }

  async getOrCreateAgent(role: AgentRole, rigId: string): Promise<Agent> {
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

  /**
   * Reconstruct a conversation transcript from an agent's persisted
   * streaming events. Delegates to the AgentDO so the TownDO doesn't
   * bear the cost of fetching and reducing thousands of events.
   */
  async reconstructConversation(agentId: string): Promise<string> {
    try {
      const agentDO = getAgentDOStub(this.env, agentId);
      return await agentDO.reconstructConversation();
    } catch (err) {
      console.error(
        `${TOWN_LOG} reconstructConversation: failed for agent=${agentId}:`,
        err instanceof Error ? err.message : err
      );
      return '';
    }
  }

  // ── Prime & Checkpoint ────────────────────────────────────────────

  async prime(agentId: string): Promise<PrimeContext> {
    return agents.prime(this.sql, agentId);
  }

  async writeCheckpoint(agentId: string, data: unknown): Promise<void> {
    agents.writeCheckpoint(this.sql, agentId, data);
  }

  async readCheckpoint(agentId: string): Promise<unknown> {
    return agents.readCheckpoint(this.sql, agentId);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────

  async touchAgentHeartbeat(
    agentId: string,
    watermark?: {
      lastEventType?: string | null;
      lastEventAt?: string | null;
      activeTools?: string[];
    }
  ): Promise<void> {
    agents.touchAgent(this.sql, agentId, watermark);
    await this.armAlarmIfNeeded();
  }

  async updateAgentStatusMessage(agentId: string, message: string): Promise<void> {
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

  /** Test-only: directly set dispatch_attempts (and optionally last_activity_at) for an agent. */
  async setAgentDispatchAttempts(
    agentId: string,
    attempts: number,
    lastActivityAt?: string
  ): Promise<void> {
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agent_metadata}
        SET ${agent_metadata.columns.dispatch_attempts} = ?,
            ${agent_metadata.columns.last_activity_at} = COALESCE(?, ${agent_metadata.columns.last_activity_at})
        WHERE ${agent_metadata.bead_id} = ?
      `,
      [attempts, lastActivityAt ?? null, agentId]
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // Mail
  // ══════════════════════════════════════════════════════════════════

  async sendMail(input: SendMailInput): Promise<void> {
    mail.sendMail(this.sql, input);
  }

  async checkMail(agentId: string): Promise<Mail[]> {
    return mail.checkMail(this.sql, agentId);
  }

  // ══════════════════════════════════════════════════════════════════
  // Nudges
  // ══════════════════════════════════════════════════════════════════

  /**
   * Queue a nudge for an agent. If mode is 'immediate', attempts to push
   * the message directly via the container and marks it delivered on success.
   * Returns the nudge_id.
   */
  async queueNudge(
    agentId: string,
    message: string,
    options?: {
      mode?: 'wait-idle' | 'immediate' | 'queue';
      priority?: 'normal' | 'urgent';
      source?: string;
      ttlSeconds?: number;
    }
  ): Promise<string> {
    const nudgeId = crypto.randomUUID();
    const mode = options?.mode ?? 'wait-idle';
    const priority = options?.priority ?? 'normal';
    const source = options?.source ?? 'system';

    let expiresAt: string | null = null;
    if (mode === 'queue' && options?.ttlSeconds != null) {
      // Use SQLite-compatible datetime format (space separator, no Z suffix) so
      // comparisons against datetime('now') work correctly.
      expiresAt = new Date(Date.now() + options.ttlSeconds * 1000)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '');
    }

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${agent_nudges} (
          ${agent_nudges.columns.nudge_id},
          ${agent_nudges.columns.agent_bead_id},
          ${agent_nudges.columns.message},
          ${agent_nudges.columns.mode},
          ${agent_nudges.columns.priority},
          ${agent_nudges.columns.source},
          ${agent_nudges.columns.expires_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [nudgeId, agentId, message, mode, priority, source, expiresAt]
    );

    console.log(
      `${TOWN_LOG} queueNudge: nudge_id=${nudgeId} agent=${agentId} mode=${mode} priority=${priority} source=${source}`
    );

    if (mode === 'immediate') {
      const sent = await dispatch.sendMessageToAgent(this.env, this.townId, agentId, message);
      if (sent) {
        query(
          this.sql,
          /* sql */ `
            UPDATE ${agent_nudges}
            SET ${agent_nudges.columns.delivered_at} = datetime('now')
            WHERE ${agent_nudges.nudge_id} = ?
          `,
          [nudgeId]
        );
        console.log(`${TOWN_LOG} queueNudge: immediate nudge delivered to agent=${agentId}`);
      } else {
        console.warn(
          `${TOWN_LOG} queueNudge: immediate delivery failed for agent=${agentId}, nudge queued for retry`
        );
      }
    }

    return nudgeId;
  }

  /**
   * Return undelivered, non-expired nudges for an agent.
   * Urgent nudges are returned first, then FIFO within same priority.
   */
  async getPendingNudges(agentId: string): Promise<
    {
      nudge_id: string;
      message: string;
      mode: string;
      priority: string;
      source: string;
    }[]
  > {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT
            ${agent_nudges.nudge_id},
            ${agent_nudges.message},
            ${agent_nudges.mode},
            ${agent_nudges.priority},
            ${agent_nudges.source}
          FROM ${agent_nudges}
          WHERE ${agent_nudges.agent_bead_id} = ?
            AND ${agent_nudges.delivered_at} IS NULL
            AND (${agent_nudges.expires_at} IS NULL OR ${agent_nudges.expires_at} > datetime('now'))
          ORDER BY
            CASE ${agent_nudges.priority} WHEN 'urgent' THEN 0 ELSE 1 END ASC,
            ${agent_nudges.created_at} ASC
        `,
        [agentId]
      ),
    ];

    return AgentNudgeRecord.pick({
      nudge_id: true,
      message: true,
      mode: true,
      priority: true,
      source: true,
    })
      .array()
      .parse(rows);
  }

  /** Mark a nudge as delivered. */
  async markNudgeDelivered(nudgeId: string): Promise<void> {
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agent_nudges}
        SET ${agent_nudges.columns.delivered_at} = datetime('now')
        WHERE ${agent_nudges.nudge_id} = ?
      `,
      [nudgeId]
    );
  }

  /**
   * Expire nudges whose expires_at has passed.
   * Called from the alarm loop. Returns the count of nudges expired.
   */
  async expireStaleNudges(): Promise<number> {
    const result = [
      ...query(
        this.sql,
        /* sql */ `
          UPDATE ${agent_nudges}
          SET ${agent_nudges.columns.delivered_at} = datetime('now')
          WHERE ${agent_nudges.expires_at} IS NOT NULL
            AND ${agent_nudges.expires_at} < datetime('now')
            AND ${agent_nudges.delivered_at} IS NULL
          RETURNING ${agent_nudges.nudge_id}
        `,
        []
      ),
    ];

    return result.length;
  }

  // ══════════════════════════════════════════════════════════════════
  // Review Queue & Molecules
  // ══════════════════════════════════════════════════════════════════

  async submitToReviewQueue(input: ReviewQueueInput): Promise<void> {
    reviewQueue.submitToReviewQueue(this.sql, input);
    this.emitEvent({
      event: 'review.submitted',
      townId: this.townId,
      rigId: input.rig_id,
      beadId: input.bead_id,
    });
    await this.armAlarmIfNeeded();
  }

  async popReviewQueue(): Promise<ReviewQueueEntry | null> {
    return reviewQueue.popReviewQueue(this.sql);
  }

  async completeReview(entryId: string, status: 'merged' | 'failed'): Promise<void> {
    reviewQueue.completeReview(this.sql, entryId, status);
  }

  async completeReviewWithResult(input: {
    entry_id: string;
    status: 'merged' | 'failed' | 'conflict';
    message?: string;
    commit_sha?: string;
  }): Promise<void> {
    // Resolve the source bead ID before completing the review, so we can
    // trigger dispatchUnblockedBeads for it after the MR closes.
    const mrBead = beadOps.getBead(this.sql, input.entry_id);
    const sourceBeadId =
      typeof mrBead?.metadata?.source_bead_id === 'string' ? mrBead.metadata.source_bead_id : null;

    reviewQueue.completeReviewWithResult(this.sql, input);

    if (input.status === 'merged') {
      this.emitEvent({
        event: 'review.completed',
        townId: this.townId,
        beadId: input.entry_id,
      });
      // When a review is merged, the source bead's pending MR is now resolved.
      // Downstream beads that were blocked (because hasUnresolvedBlockers saw
      // the open MR) should now be dispatched.
      if (sourceBeadId) {
        this.dispatchUnblockedBeads(sourceBeadId);
      }
    } else if (input.status === 'failed' || input.status === 'conflict') {
      this.emitEvent({
        event: 'review.failed',
        townId: this.townId,
        beadId: input.entry_id,
      });
    }

    // Rework is handled by the normal scheduling path: the failed/conflict
    // path in completeReviewWithResult sets the source bead to 'open' with
    // assignee cleared. feedStrandedConvoys or rehookOrphanedBeads will
    // hook a polecat, and schedulePendingWork will dispatch it.
  }

  async agentDone(agentId: string, input: AgentDoneInput): Promise<void> {
    // Event-only: record the fact. The alarm's Phase 0 drains and
    // applies all pending events before reconciliation runs. DO RPCs
    // are serialized, so agentCompleted can't race with this — it
    // waits for agentDone to finish before executing.
    events.insertEvent(this.sql, 'agent_done', {
      agent_id: agentId,
      payload: {
        branch: input.branch,
        ...(input.pr_url ? { pr_url: input.pr_url } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
      },
    });
    await this.armAlarmIfNeeded();
  }

  async agentCompleted(
    agentId: string,
    input: { status: 'completed' | 'failed'; reason?: string }
  ): Promise<void> {
    // Resolve empty agentId to mayor (backwards compat with container callback)
    let resolvedAgentId = agentId;
    if (!resolvedAgentId) {
      const mayor = agents.listAgents(this.sql, { role: 'mayor' })[0];
      if (mayor) resolvedAgentId = mayor.id;
    }

    // Event-only: record the fact. The alarm's Phase 0 drains and
    // applies all pending events. DO RPCs are serialized so there's
    // no race with agentDone.
    events.insertEvent(this.sql, 'agent_completed', {
      agent_id: resolvedAgentId || agentId,
      payload: {
        status: input.status,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });

    // Emit analytics event (not part of reconciler — UI/observability concern)
    if (resolvedAgentId) {
      const agent = agents.getAgent(this.sql, resolvedAgentId);
      this.emitEvent({
        event: 'agent.exited',
        townId: this.townId,
        agentId: resolvedAgentId,
        role: agent?.role,
      });
    }
    await this.armAlarmIfNeeded();
    // Rework dispatch is handled by the reconciler's reconcileBeads Rule 1:
    // open beads with no assignee get agents on the next alarm tick.
  }

  /**
   * Refinery requests changes on an in-progress MR bead. Creates a rework
   * bead that blocks the MR bead. The refinery should call gt_done after
   * this to release its session. The reconciler assigns a polecat to the
   * rework bead; when it closes, the MR unblocks and the refinery re-reviews.
   */
  async requestChanges(
    agentId: string,
    input: { feedback: string; files?: string[] }
  ): Promise<{ rework_bead_id: string }> {
    const agent = agents.getAgent(this.sql, agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (agent.role !== 'refinery') throw new Error(`Only refineries can request changes`);
    if (!agent.current_hook_bead_id) throw new Error(`Agent ${agentId} is not hooked to a bead`);

    const mrBead = beadOps.getBead(this.sql, agent.current_hook_bead_id);
    if (!mrBead || mrBead.type !== 'merge_request') {
      throw new Error(`Agent ${agentId} is not hooked to a merge_request bead`);
    }

    // Find the source bead (the original issue the polecat worked on)
    const sourceBeadId =
      typeof mrBead.metadata?.source_bead_id === 'string' ? mrBead.metadata.source_bead_id : null;
    const sourceBead = sourceBeadId ? beadOps.getBead(this.sql, sourceBeadId) : null;

    // Get branch info from review_metadata
    const reviewMeta = reviewQueue.getReviewMetadata(this.sql, mrBead.bead_id);

    const reworkBead = beadOps.createBead(this.sql, {
      type: 'issue',
      title: `Rework: ${sourceBead?.title ?? mrBead.title}`,
      body: input.feedback,
      priority: sourceBead?.priority ?? 'medium',
      rig_id: mrBead.rig_id ?? undefined,
      labels: ['gt:rework'],
      metadata: {
        rework_for: sourceBeadId,
        mr_bead_id: mrBead.bead_id,
        branch: reviewMeta?.branch ?? null,
        target_branch: reviewMeta?.target_branch ?? null,
        files: input.files ?? [],
      },
    });

    // Rework bead blocks the MR bead — MR can't proceed until rework is done
    beadOps.insertDependency(this.sql, mrBead.bead_id, reworkBead.bead_id, 'blocks');

    // Record event so the reconciler picks up the rework bead
    events.insertEvent(this.sql, 'bead_created', {
      bead_id: reworkBead.bead_id,
      payload: { bead_type: 'issue', rig_id: mrBead.rig_id },
    });

    beadOps.logBeadEvent(this.sql, {
      beadId: mrBead.bead_id,
      agentId,
      eventType: 'rework_requested',
      newValue: reworkBead.bead_id,
      metadata: { feedback: input.feedback.slice(0, 500), files: input.files },
    });

    console.log(
      `${TOWN_LOG} requestChanges: refinery=${agentId} mr=${mrBead.bead_id} rework=${reworkBead.bead_id}`
    );

    await this.armAlarmIfNeeded();
    return { rework_bead_id: reworkBead.bead_id };
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
          // Nudge the stuck agent — time-sensitive, deliver immediately
          if (targetAgent && targetAgentId) {
            this.queueNudge(
              targetAgentId,
              input.resolution_notes ||
                'The triage system has flagged you as potentially stuck. Please report your status.',
              { mode: 'immediate', source: 'triage', priority: 'urgent' }
            ).catch(err =>
              console.warn(
                `${TOWN_LOG} resolveTriage: nudge failed for agent=${targetAgentId}:`,
                err
              )
            );
            this.emitEvent({
              event: 'nudge.queued',
              townId: this.townId,
              agentId: targetAgentId,
              label: 'triage_nudge',
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
    return reviewQueue.createMolecule(this.sql, beadId, formula);
  }

  async getMoleculeCurrentStep(
    agentId: string
  ): Promise<{ molecule: Molecule; step: unknown } | null> {
    return reviewQueue.getMoleculeCurrentStep(this.sql, agentId);
  }

  async advanceMoleculeStep(agentId: string, summary: string): Promise<Molecule | null> {
    return reviewQueue.advanceMoleculeStep(this.sql, agentId, summary);
  }

  async getMergeQueueData(params: {
    rigId?: string;
    limit?: number;
    since?: string;
  }): Promise<reviewQueue.MergeQueueData> {
    return reviewQueue.getMergeQueueData(this.sql, params);
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
    const createdBead = beadOps.createBead(this.sql, {
      type: 'issue',
      title: input.title,
      body: input.body,
      priority: BeadPriority.catch('medium').parse(input.priority ?? 'medium'),
      rig_id: input.rigId,
      metadata: input.metadata,
    });

    events.insertEvent(this.sql, 'bead_created', {
      bead_id: createdBead.bead_id,
      payload: { bead_type: 'issue', rig_id: input.rigId, has_blockers: false },
    });

    // Fast path: assign agent immediately for UX ("Toast is on it!")
    // rather than waiting for the next alarm tick. Uses the same
    // getOrCreateAgent + hookBead path the reconciler would use.
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
    Array<{
      rigId: string;
      gitUrl: string;
      defaultBranch: string;
      platformIntegrationId?: string;
    }>
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
    _model?: string,
    uiContext?: string
  ): Promise<{
    agentId: string;
    sessionStatus: 'idle' | 'active' | 'starting';
  }> {
    return withLogTags({ source: 'Town.do', tags: { townId: this.townId } }, () =>
      this._sendMayorMessage(message, _model, uiContext)
    );
  }

  private async _sendMayorMessage(
    message: string,
    _model?: string,
    uiContext?: string
  ): Promise<{
    agentId: string;
    sessionStatus: 'idle' | 'active' | 'starting';
  }> {
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

    logger.setTags({ agentId: mayor.id });
    logger.info('sendMayorMessage', {
      containerStatus: containerStatus.status,
      isAlive,
    });

    const effectiveContext = uiContext ?? this._dashboardContext;
    const combinedMessage = effectiveContext
      ? `<system-reminder>\n${effectiveContext}\n</system-reminder>\n\n${message}`
      : message;

    let sessionStatus: 'idle' | 'active' | 'starting';

    if (isAlive) {
      const sent = await dispatch.sendMessageToAgent(this.env, townId, mayor.id, combinedMessage);
      sessionStatus = sent ? 'active' : 'idle';
    } else {
      const townConfig = await this.getTownConfig();
      const rigConfig = await this.getMayorRigConfig();
      const kilocodeToken = await this.resolveKilocodeToken();

      logger.info('sendMayorMessage: starting container', {
        hasRigConfig: !!rigConfig,
        hasKilocodeToken: !!kilocodeToken,
        townConfigToken: !!townConfig.kilocode_token,
        rigConfigToken: !!rigConfig?.kilocodeToken,
        userId: townConfig.owner_user_id ?? rigConfig?.userId,
        orgId: townConfig.organization_id,
      });

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
        beadTitle: combinedMessage,
        beadBody: '',
        checkpoint: agents.readCheckpoint(this.sql, mayor.id),
        conversationHistory: await this.reconstructConversation(mayor.id),
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
  async ensureMayor(): Promise<{
    agentId: string;
    sessionStatus: 'idle' | 'active' | 'starting';
  }> {
    return withLogTags({ source: 'Town.do', tags: { townId: this.townId } }, () =>
      this._ensureMayor()
    );
  }

  private async _ensureMayor(): Promise<{
    agentId: string;
    sessionStatus: 'idle' | 'active' | 'starting';
  }> {
    const townId = this.townId;

    let mayor = agents.listAgents(this.sql, { role: 'mayor' })[0] ?? null;
    if (!mayor) {
      const identity = `mayor-${townId.slice(0, 8)}`;
      mayor = agents.registerAgent(this.sql, {
        role: 'mayor',
        name: 'mayor',
        identity,
      });
      logger.info('ensureMayor: created mayor agent', { agentId: mayor.id });
    }

    logger.setTags({ agentId: mayor.id });

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
      logger.warn('ensureMayor: no kilocodeToken available, deferring start', {
        userId: townConfig.owner_user_id,
        orgId: townConfig.organization_id,
      });
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
      userId:
        townConfig.owner_user_id ?? rigConfig?.userId ?? townConfig.created_by_user_id ?? townId,
      agentId: mayor.id,
      agentName: 'mayor',
      role: 'mayor',
      identity: mayor.identity,
      beadId: '',
      beadTitle: 'Mayor ready. Waiting for instructions.',
      beadBody: '',
      checkpoint: agents.readCheckpoint(this.sql, mayor.id),
      conversationHistory: await this.reconstructConversation(mayor.id),
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

  /**
   * Hot-update the mayor's model without restarting the session.
   * Patches the running SDK server config and per-message model override
   * so both the mayor and its sub-agents use the new model immediately.
   */
  async updateMayorModel(model: string, smallModel?: string): Promise<void> {
    const townId = this.townId;
    const mayor = agents.listAgents(this.sql, { role: 'mayor' })[0];
    if (!mayor) return;

    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, townId, mayor.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';

    if (isAlive) {
      const updated = await dispatch.updateAgentModelInContainer(
        this.env,
        townId,
        mayor.id,
        model,
        smallModel
      );
      if (updated) {
        console.log(
          `${TOWN_LOG} updateMayorModel: hot-updated mayor ${mayor.id} to model=${model}`
        );
      } else {
        console.warn(`${TOWN_LOG} updateMayorModel: failed to hot-update mayor ${mayor.id}`);
      }
    }
    // If the mayor is not alive, the next dispatch will pick up the new
    // model from the updated town config automatically.
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
    this.emitEvent({
      event: 'convoy.created',
      townId: this.townId,
      convoyId,
    });
    return convoy;
  }

  async onBeadClosed(input: { convoyId: string; beadId: string }): Promise<ConvoyEntry | null> {
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
    if (convoy) {
      this.broadcastConvoyProgress(input.convoyId, convoy.total_beads, convoy.closed_beads);
    }
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
      this.emitEvent({
        event: 'convoy.landed',
        townId: this.townId,
        convoyId: input.convoyId,
      });
      return this.getConvoy(input.convoyId);
    }
    return convoy;
  }

  /**
   * Force-close a convoy and all its tracked beads. Unhooks any agents
   * still assigned to those beads so they return to the idle pool.
   */
  async closeConvoy(convoyId: string): Promise<ConvoyEntry | null> {
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
    staged?: boolean;
  }): Promise<{
    convoy: ConvoyEntry;
    beads: Array<{ bead: Bead; agent: Agent | null }>;
  }> {
    // Resolve staged: explicit request wins, otherwise fall back to town config default.
    const townConfig = await this.getTownConfig();
    const isStaged = input.staged ?? townConfig.staged_convoys_default;

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

    const stagedValue = isStaged ? 1 : 0;

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${convoy_metadata} (
          ${convoy_metadata.columns.bead_id}, ${convoy_metadata.columns.total_beads},
          ${convoy_metadata.columns.closed_beads}, ${convoy_metadata.columns.landed_at},
          ${convoy_metadata.columns.feature_branch}, ${convoy_metadata.columns.merge_mode},
          ${convoy_metadata.columns.staged}
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [convoyId, input.tasks.length, 0, null, featureBranch, mergeMode, stagedValue]
    );

    // 2. Create all beads and track their IDs (needed for depends_on resolution)
    const beadIds: string[] = [];
    const results: Array<{ bead: Bead; agent: Agent | null }> = [];

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

    // Record bead_created events for reconciler (dual-write, no behavior change)
    for (let i = 0; i < beadIds.length; i++) {
      const hasBlockers = (input.tasks[i].depends_on ?? []).length > 0;
      events.insertEvent(this.sql, 'bead_created', {
        bead_id: beadIds[i],
        payload: {
          bead_type: 'issue',
          rig_id: input.rigId,
          convoy_id: convoyId,
          has_blockers: hasBlockers,
        },
      });
    }

    // Lazy assignment: beads are created with no assignee. The reconciler's
    // reconcileBeads Rule 1 assigns agents to unblocked beads on the next
    // alarm tick. This avoids creating N polecats upfront for a convoy
    // where only 1-3 beads are unblocked initially (#1249).
    for (const beadId of beadIds) {
      const bead = beadOps.getBead(this.sql, beadId);
      if (!bead) continue;
      results.push({ bead, agent: null });
    }

    if (!isStaged) {
      await this.armAlarmIfNeeded();
    }

    const convoy = this.getConvoy(convoyId);
    if (!convoy) throw new Error('Failed to create convoy');
    this.emitEvent({
      event: 'convoy.created',
      townId: this.townId,
      convoyId,
    });
    return { convoy, beads: results };
  }

  /**
   * Transition a staged convoy to active: hook agents and begin dispatch.
   */
  async startConvoy(convoyId: string): Promise<{
    convoy: ConvoyEntry;
    beads: Array<{ bead: Bead; agent: Agent | null }>;
  }> {
    const convoy = this.getConvoy(convoyId);
    if (!convoy) throw new Error(`Convoy not found: ${convoyId}`);
    if (!convoy.staged) throw new Error(`Convoy is not staged: ${convoyId}`);

    // Find all beads tracked by this convoy
    const trackedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${bead_dependencies.bead_id}
          FROM ${bead_dependencies}
          WHERE ${bead_dependencies.depends_on_bead_id} = ?
            AND ${bead_dependencies.dependency_type} = 'tracks'
        `,
        [convoyId]
      ),
    ];

    const BeadIdRow = z.object({ bead_id: z.string() });
    const trackedBeadIds = BeadIdRow.array()
      .parse(trackedRows)
      .map(r => r.bead_id);

    const results: Array<{ bead: Bead; agent: Agent | null }> = [];

    // Lazy assignment: just collect beads. The reconciler's reconcileBeads
    // Rule 1 assigns agents to unblocked beads on the next alarm tick.
    for (const beadId of trackedBeadIds) {
      const bead = beadOps.getBead(this.sql, beadId);
      if (!bead) continue;
      results.push({ bead, agent: null });
    }

    // Clear the staged flag so the reconciler sees these beads as active.
    query(
      this.sql,
      /* sql */ `
        UPDATE ${convoy_metadata}
        SET ${convoy_metadata.columns.staged} = 0
        WHERE ${convoy_metadata.bead_id} = ?
      `,
      [convoyId]
    );

    events.insertEvent(this.sql, 'convoy_started', {
      payload: { convoy_id: convoyId },
    });

    await this.armAlarmIfNeeded();

    const updatedConvoy = this.getConvoy(convoyId);
    if (!updatedConvoy) throw new Error(`Failed to re-fetch convoy after start: ${convoyId}`);
    this.emitEvent({
      event: 'convoy.started',
      townId: this.townId,
      convoyId,
    });
    return { convoy: updatedConvoy, beads: results };
  }

  /**
   * List active convoys with progress counts.
   */
  async listConvoys(): Promise<ConvoyEntry[]> {
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
    query(
      this.sql,
      /* sql */ `
        UPDATE ${escalation_metadata}
        SET ${escalation_metadata.columns.acknowledged} = 1, ${escalation_metadata.columns.acknowledged_at} = ?
        WHERE ${escalation_metadata.bead_id} = ? AND ${escalation_metadata.acknowledged} = 0
      `,
      [now(), escalationId]
    );
    // Acknowledging an escalation also closes it — the mayor has seen
    // the issue and doesn't need it sitting open in the queue.
    // Guard with getBead so stale/duplicate acknowledge calls remain
    // idempotent instead of throwing on a missing bead.
    const escalationBead = beadOps.getBead(this.sql, escalationId);
    if (escalationBead && escalationBead.status !== 'closed') {
      beadOps.updateBeadStatus(this.sql, escalationId, 'closed', null);
    }
    this.emitEvent({
      event: 'escalation.acknowledged',
      townId: this.townId,
      beadId: escalationId,
    });
    return this.getEscalation(escalationId);
  }

  async listEscalations(filter?: { acknowledged?: boolean }): Promise<EscalationEntry[]> {
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

    this.emitEvent({
      event: 'escalation.created',
      townId: this.townId,
      rigId: input.source_rig_id,
      agentId: input.source_agent_id,
      beadId,
      convoyId: convoyId ?? undefined,
    });

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
    return withLogTags({ source: 'Town.do' }, async () => {
      await this._alarm();
    });
  }

  private async _alarm(): Promise<void> {
    // Exit condition: if this DO was destroyed, don't re-arm.
    // After destroy(), deleteAll() wipes storage but may not clear
    // the alarm (compat date < 2026-02-24). A resurrected alarm
    // will find no town:id — stop the loop immediately.
    const storedId = await this.ctx.storage.get<string>('town:id');
    if (!storedId) {
      logger.info('alarm: no town:id — town was destroyed, not re-arming');
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const townId = this.townId;
    logger.setTags({ townId });
    logger.info('alarm: fired');

    const hasRigs = rigs.listRigs(this.sql).length > 0;
    if (hasRigs) {
      try {
        await this.ensureContainerReady();
      } catch (err) {
        logger.warn('alarm: container health check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Refresh the container-scoped JWT before any work that might
      // trigger API calls. Throttled to once per hour (tokens have 8h
      // expiry, so hourly refresh provides ample safety margin).
      // Gated on hasRigs (not hasActiveWork) because the container may
      // still be running with an idle mayor accepting user messages,
      // even when there are no active beads or agents.
      try {
        await this.refreshContainerToken();
      } catch (err) {
        logger.warn('alarm: refreshContainerToken failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Pre-phase: Observe container status for working agents ────────
    // Replaces witnessPatrol's zombie detection. Poll the container for
    // each working/stalled agent and emit container_status events. These
    // are drained in Phase 0 and applied before reconciliation.
    try {
      const workingAgentRows = z
        .object({ bead_id: z.string() })
        .array()
        .parse([
          ...query(
            this.sql,
            /* sql */ `
            SELECT ${agent_metadata.bead_id}
            FROM ${agent_metadata}
            WHERE ${agent_metadata.status} IN ('working', 'stalled')
          `,
            []
          ),
        ]);

      if (workingAgentRows.length > 0) {
        const statusChecks = workingAgentRows.map(async row => {
          try {
            const containerInfo = await dispatch.checkAgentContainerStatus(
              this.env,
              townId,
              row.bead_id
            );
            // Skip inserting events for 'running' — it's the steady-state and
            // a no-op in applyEvent, so recording it just bloats the event table
            // (~720 events/hour/agent). Non-running statuses (stopped, error,
            // unknown) still get inserted so the reconciler can detect and handle them.
            if (containerInfo.status !== 'running') {
              events.upsertContainerStatus(this.sql, row.bead_id, {
                status: containerInfo.status,
                exit_reason: containerInfo.exitReason,
              });
            }
          } catch (err) {
            logger.warn('alarm: container status check failed', {
              agentId: row.bead_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
        await Promise.allSettled(statusChecks);
      }
    } catch (err) {
      logger.error('alarm: container observation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Reconciler loop (Phase 0-2) with metrics ─────────────────────
    const reconcilerStart = Date.now();
    const metrics: reconciler.ReconcilerMetrics = {
      eventsDrained: 0,
      actionsEmitted: 0,
      actionsByType: {},
      sideEffectsAttempted: 0,
      sideEffectsSucceeded: 0,
      sideEffectsFailed: 0,
      invariantViolations: 0,
      wallClockMs: 0,
      pendingEventCount: 0,
    };

    // Phase 0: Drain events and apply state transitions
    try {
      const pending = events.drainEvents(this.sql);
      metrics.eventsDrained = pending.length;
      if (pending.length > 0) {
        logger.info('reconciler: draining events', { count: pending.length });
      }
      for (const event of pending) {
        try {
          reconciler.applyEvent(this.sql, event);
          events.markProcessed(this.sql, event.event_id);
        } catch (err) {
          logger.error('reconciler: applyEvent failed', {
            eventId: event.event_id,
            eventType: event.event_type,
            error: err instanceof Error ? err.message : String(err),
          });
          // Event stays unprocessed — will be retried on the next alarm tick.
          // Mark it processed anyway after 3 consecutive failures to prevent
          // a poison event from blocking the entire queue forever.
          // For now, we skip it and let the next tick retry.
        }
      }
    } catch (err) {
      logger.error('reconciler: event drain failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      Sentry.captureException(err);
    }

    // Phase 1: Reconcile — compute desired state vs actual state
    const sideEffects: Array<() => Promise<void>> = [];
    try {
      const actions = reconciler.reconcile(this.sql);
      metrics.actionsEmitted = actions.length;
      for (const a of actions) {
        metrics.actionsByType[a.type] = (metrics.actionsByType[a.type] ?? 0) + 1;
      }
      if (actions.length > 0) {
        logger.info('reconciler: actions computed', {
          count: actions.length,
          types: [...new Set(actions.map(a => a.type))].join(','),
        });
      }
      const ctx = this.applyActionCtx;
      for (const action of actions) {
        try {
          const effect = applyAction(ctx, action);
          if (effect) sideEffects.push(effect);
        } catch (err) {
          logger.error('reconciler: applyAction failed', {
            actionType: action.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error('reconciler: reconcile failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      Sentry.captureException(err);
    }

    // Phase 2: Execute side effects (async, best-effort)
    metrics.sideEffectsAttempted = sideEffects.length;
    if (sideEffects.length > 0) {
      const results = await Promise.allSettled(sideEffects.map(fn => fn()));
      for (const r of results) {
        if (r.status === 'fulfilled') metrics.sideEffectsSucceeded++;
        else metrics.sideEffectsFailed++;
      }
    }

    // Post-reconcile: Invariant checker
    try {
      const violations = reconciler.checkInvariants(this.sql);
      metrics.invariantViolations = violations.length;
      if (violations.length > 0) {
        // Emit as an analytics event for observability dashboards instead
        // of console.error (which spams Workers logs every 5s per town).
        this.emitEvent({
          event: 'reconciler.invariant_violations',
          townId,
          label: violations.map(v => `[${v.invariant}] ${v.message}`).join('; '),
          value: violations.length,
        });

        for (const violation of violations) {
          Sentry.captureMessage(
            `Reconciler invariant #${violation.invariant} violated: ${violation.message}`,
            {
              level: 'error',
              extra: {
                invariant: violation.invariant,
                message: violation.message,
                townId,
              },
              tags: {
                invariant: String(violation.invariant),
                townId,
              },
            }
          );

          // TODO: auto-recovery for invariant #7 (working agent with no hook).
          // Transitioning to idle requires unhooking side-effects (container stop,
          // bead status rollback) that live in agents.ts — needs a dedicated
          // recovery action in the reconciler rather than a raw SQL update here.
        }
      }
    } catch (err) {
      logger.warn('reconciler: invariant check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    metrics.wallClockMs = Date.now() - reconcilerStart;
    metrics.pendingEventCount = events.pendingEventCount(this.sql);
    this._lastReconcilerMetrics = metrics;

    // Emit reconciler metrics to Analytics Engine for Grafana dashboards.
    // Field mapping:
    //   double1  = wallClockMs
    //   double2  = eventsDrained
    //   double3  = actionsEmitted
    //   double4  = sideEffectsAttempted
    //   double5  = sideEffectsSucceeded
    //   double6  = sideEffectsFailed
    //   double7  = invariantViolations
    //   double8  = pendingEventCount
    //   blob10   = JSON-encoded actionsByType breakdown
    this.emitEvent({
      event: 'reconciler_tick',
      townId,
      durationMs: metrics.wallClockMs,
      value: metrics.eventsDrained,
      double3: metrics.actionsEmitted,
      double4: metrics.sideEffectsAttempted,
      double5: metrics.sideEffectsSucceeded,
      double6: metrics.sideEffectsFailed,
      double7: metrics.invariantViolations,
      double8: metrics.pendingEventCount,
      label: JSON.stringify(metrics.actionsByType),
    });

    // ── Phase 3: Housekeeping (independent, all parallelizable) ────
    await Promise.allSettled([
      this.deliverPendingMail().catch(err =>
        logger.warn('alarm: deliverPendingMail failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      ),
      this.expireStaleNudges().catch(err =>
        logger.warn('alarm: expireStaleNudges failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      ),
      this.reEscalateStaleEscalations().catch(err =>
        logger.warn('alarm: reEscalation failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      ),
      this.maybeDispatchTriageAgent().catch(err =>
        logger.warn('alarm: maybeDispatchTriageAgent failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      ),
      // Prune processed reconciler events older than 7 days
      Promise.resolve().then(() => {
        try {
          events.pruneOldEvents(this.sql, 7 * 24 * 60 * 60 * 1000);
        } catch (err) {
          logger.warn('alarm: event pruning failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    ]);
    // Re-arm: fast when active, slow when idle
    const active = this.hasActiveWork();
    const interval = active ? ACTIVE_ALARM_INTERVAL_MS : IDLE_ALARM_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Date.now() + interval);

    // Broadcast status snapshot to connected WebSocket clients
    try {
      const snapshot = await this.getAlarmStatus();
      this.broadcastAlarmStatus(snapshot);
    } catch (err) {
      logger.warn('alarm: status broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
    return scheduling.hasActiveWork(this.sql);
  }

  /** Dispatch a single agent to the container. Delegates to scheduling module. */
  private dispatchAgent(
    agent: Agent,
    bead: Bead,
    options?: { systemPromptOverride?: string }
  ): Promise<boolean> {
    return scheduling.dispatchAgent(this.schedulingCtx, agent, bead, options);
  }

  /** When a bead closes, dispatch any beads it was blocking. */
  private dispatchUnblockedBeads(closedBeadId: string): void {
    scheduling.dispatchUnblockedBeads(this.schedulingCtx, closedBeadId);
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
    const cooldownCutoff = new Date(Date.now() - scheduling.DISPATCH_COOLDOWN_MS).toISOString();
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
        if (
          messages.some(
            m =>
              m.subject === 'TRIAGE_NUDGE' ||
              m.subject === 'GUPP_ESCALATION' ||
              m.subject === 'GUPP_CHECK'
          )
        ) {
          this.emitEvent({
            event: 'nudge.delivered',
            townId: this.townId,
            agentId,
          });
        }
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
      await container.fetch('http://container/health', {
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Container is starting up or unavailable — alarm will retry
    }
  }

  // ── Alarm helpers ─────────────────────────────────────────────────

  private async armAlarmIfNeeded(): Promise<void> {
    // Don't resurrect the alarm on a destroyed DO. After destroy(),
    // town:id is wiped — if it's missing, the town was deleted.
    const storedId = await this.ctx.storage.get<string>('town:id');
    if (!storedId) return;

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
    reconciler: reconciler.ReconcilerMetrics | null;
    recentEvents: Array<{
      time: string;
      type: string;
      message: string;
    }>;
  }> {
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
    const beadCounts = {
      open: 0,
      inProgress: 0,
      inReview: 0,
      failed: 0,
      triageRequests: 0,
    };
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
      reconciler: this._lastReconcilerMetrics,
      recentEvents,
    };
  }

  // DEBUG: replay events from a time range, apply them to state, run the
  // reconciler, and return computed actions. Uses a savepoint + rollback so
  // no state is permanently modified.
  //
  // CAVEAT: events are re-applied on top of current (live) state, not from a
  // clean snapshot taken before the requested window. Non-idempotent handlers
  // (e.g. agentDone, completeReviewWithResult) may target different beads than
  // they originally did, so actions and snapshots are approximate — useful for
  // debugging event flow, not for faithful historical reconstruction.
  async debugReplayEvents(
    from: string,
    to: string
  ): Promise<{
    caveat: string;
    eventsReplayed: number;
    actions: Action[];
    stateSnapshot: {
      agents: unknown[];
      nonTerminalBeads: unknown[];
    };
  }> {
    this.sql.exec('SAVEPOINT debug_replay_events');
    try {
      // Query ALL events in the time range regardless of processed_at
      const rangeEvents = TownEventRecord.array().parse([
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${town_events.event_id}, ${town_events.event_type},
                   ${town_events.agent_id}, ${town_events.bead_id},
                   ${town_events.payload}, ${town_events.created_at},
                   ${town_events.processed_at}
            FROM ${town_events}
            WHERE ${town_events.created_at} >= ?
              AND ${town_events.created_at} <= ?
            ORDER BY ${town_events.created_at} ASC
          `,
          [from, to]
        ),
      ]);

      // Apply each event to reconstruct state transitions
      for (const event of rangeEvents) {
        reconciler.applyEvent(this.sql, event);
      }

      // Run reconciler against the resulting state
      const actions = reconciler.reconcile(this.sql);

      // Capture a state snapshot before rollback
      const agentSnapshot = [
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${agent_metadata.bead_id},
                   ${agent_metadata.role},
                   ${agent_metadata.status},
                   ${agent_metadata.current_hook_bead_id},
                   ${agent_metadata.dispatch_attempts},
                   ${agent_metadata.last_activity_at}
            FROM ${agent_metadata}
          `,
          []
        ),
      ];

      const beadSnapshot = [
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${beads.bead_id},
                   ${beads.type},
                   ${beads.status},
                   ${beads.title},
                   ${beads.assignee_agent_bead_id},
                   ${beads.updated_at}
            FROM ${beads}
            WHERE ${beads.status} NOT IN ('closed', 'failed')
              AND ${beads.type} != 'agent'
            ORDER BY ${beads.type}, ${beads.status}
          `,
          []
        ),
      ];

      return {
        caveat:
          'Events are re-applied on top of current live state, not from a pre-window snapshot. ' +
          'Non-idempotent handlers may produce different results than the original processing. ' +
          'Use for debugging event flow, not faithful historical reconstruction.',
        eventsReplayed: rangeEvents.length,
        actions,
        stateSnapshot: {
          agents: agentSnapshot,
          nonTerminalBeads: beadSnapshot,
        },
      };
    } finally {
      this.sql.exec('ROLLBACK TO SAVEPOINT debug_replay_events');
      this.sql.exec('RELEASE SAVEPOINT debug_replay_events');
    }
  }

  // DEBUG: dry-run the reconciler against current state, returning actions
  // it would emit without applying them. Drains pending events first (same
  // as the real alarm loop) inside a savepoint that is rolled back, so the
  // endpoint remains fully side-effect-free.
  async debugDryRun(): Promise<{
    actions: Action[];
    metrics: Pick<
      reconciler.ReconcilerMetrics,
      'actionsEmitted' | 'actionsByType' | 'pendingEventCount' | 'eventsDrained'
    >;
  }> {
    // Use a savepoint so we can drain events (which mutates state)
    // then roll back without permanent side effects
    this.sql.exec('SAVEPOINT debug_dry_run');
    try {
      // Phase 0: Drain and apply pending events (same as real alarm loop)
      const pending = events.drainEvents(this.sql);
      for (const event of pending) {
        reconciler.applyEvent(this.sql, event);
        events.markProcessed(this.sql, event.event_id);
      }

      // Phase 1: Reconcile against now-current state
      const actions = reconciler.reconcile(this.sql);
      const pendingEventCount = events.pendingEventCount(this.sql);
      const actionsByType: Record<string, number> = {};
      for (const a of actions) {
        actionsByType[a.type] = (actionsByType[a.type] ?? 0) + 1;
      }

      return {
        actions,
        metrics: {
          actionsEmitted: actions.length,
          actionsByType,
          pendingEventCount,
          eventsDrained: pending.length,
        },
      };
    } finally {
      // Roll back all state mutations — this is a dry run
      this.sql.exec('ROLLBACK TO SAVEPOINT debug_dry_run');
      this.sql.exec('RELEASE SAVEPOINT debug_dry_run');
    }
  }

  // DEBUG: concise non-terminal bead summary — remove after debugging
  async debugBeadSummary(): Promise<unknown[]> {
    return [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${beads.bead_id},
                 ${beads.type},
                 ${beads.status},
                 ${beads.title},
                 ${beads.assignee_agent_bead_id},
                 ${beads.updated_at}
          FROM ${beads}
          WHERE ${beads.status} NOT IN ('closed', 'failed')
            AND ${beads.type} != 'agent'
          ORDER BY ${beads.type}, ${beads.status}
        `,
        []
      ),
    ];
  }

  // DEBUG: raw agent_metadata dump — remove after debugging
  async debugAgentMetadata(): Promise<unknown[]> {
    return [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agent_metadata.bead_id},
                 ${agent_metadata.role},
                 ${agent_metadata.status},
                 ${agent_metadata.current_hook_bead_id},
                 ${agent_metadata.dispatch_attempts},
                 ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
        `,
        []
      ),
    ];
  }

  async destroy(): Promise<void> {
    console.log(`${TOWN_LOG} destroy: clearing all storage and alarms`);

    // Destroy all AgentDOs (clears agent_events tables)
    try {
      const allAgents = agents.listAgents(this.sql);
      await Promise.allSettled(
        allAgents.map(agent => getAgentDOStub(this.env, agent.id).destroy())
      );
    } catch (err) {
      console.warn(`${TOWN_LOG} destroy: agent cleanup failed`, err);
    }

    // Destroy TownContainerDO (sends SIGKILL to container process, clears state)
    try {
      const containerStub = getTownContainerStub(this.env, this.townId);
      await containerStub.destroy();
    } catch (err) {
      console.warn(`${TOWN_LOG} destroy: container cleanup failed`, err);
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export function getTownDOStub(env: Env, townId: string) {
  return env.TOWN.get(env.TOWN.idFromName(townId));
}
