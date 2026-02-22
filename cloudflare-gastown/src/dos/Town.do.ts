/**
 * TownDO — The single source of truth for all control-plane data.
 *
 * After the town-centric refactor (#419), ALL gastown state lives here:
 * rigs, agents, beads, mail, review queues, molecules, bead events,
 * convoys, escalations, and configuration.
 *
 * Agent events (high-volume SSE/streaming data) are delegated to per-agent
 * AgentDOs to stay within the 10GB DO SQLite limit.
 *
 * The Rig DO and Mayor DO are eliminated. The mayor is tracked as a
 * regular agent row with role='mayor'.
 */

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

// Sub-modules (plain functions, not classes — per coding style)
import * as beads from './town/beads';
import * as agents from './town/agents';
import * as mail from './town/mail';
import * as reviewQueue from './town/review-queue';
import * as config from './town/config';
import * as rigs from './town/rigs';
import * as dispatch from './town/container-dispatch';

// Table imports for convoys + escalations (kept inline since they're small)
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
import { rig_agents, RigAgentRecord } from '../db/tables/rig-agents.table';
import { rig_beads, RigBeadRecord } from '../db/tables/rig-beads.table';
import { rig_review_queue } from '../db/tables/rig-review-queue.table';
import { rig_mail } from '../db/tables/rig-mail.table';
import { query } from '../util/query.util';
import { getAgentDOStub } from './Agent.do';
import { getTownContainerStub } from './TownContainer.do';

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
} from '../types';
import type { RigBeadEventRecord } from '../db/tables/rig-bead-events.table';
import type { RigMoleculeRecord } from '../db/tables/rig-molecules.table';

const TOWN_LOG = '[Town.do]';

// Alarm intervals
const ACTIVE_ALARM_INTERVAL_MS = 15_000; // 15s when agents are active
const IDLE_ALARM_INTERVAL_MS = 5 * 60_000; // 5m when idle
const STALE_THRESHOLD_MS = 10 * 60_000; // 10 min
const GUPP_THRESHOLD_MS = 30 * 60_000; // 30 min
const MAX_DISPATCH_ATTEMPTS = 5;
const DEFAULT_MAX_POLECATS = 5;

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
};

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
    // Load persisted town ID if available
    const storedId = await this.ctx.storage.get<string>('town:id');
    if (storedId) this._townId = storedId;

    // Rig-scoped tables (formerly in Rig DO)
    beads.initBeadTables(this.sql);
    agents.initAgentTables(this.sql);
    mail.initMailTables(this.sql);
    reviewQueue.initReviewQueueTables(this.sql);

    // Rig registry
    rigs.initRigTables(this.sql);

    // Town-scoped tables
    query(this.sql, createTableTownConvoys(), []);
    query(this.sql, createTableTownConvoyBeads(), []);
    query(this.sql, createTableTownEscalations(), []);

    // Composite PK for convoy_beads
    query(
      this.sql,
      /* sql */ `CREATE UNIQUE INDEX IF NOT EXISTS idx_town_convoy_beads_pk ON ${town_convoy_beads}(${town_convoy_beads.columns.convoy_id}, ${town_convoy_beads.columns.bead_id})`,
      []
    );
  }

  private _townId: string | null = null;

  private get townId(): string {
    // ctx.id.name should be the town UUID (set via idFromName in getTownDOStub).
    // In some runtimes (local dev) .name is undefined. We persist the ID
    // in KV on first access so it survives across requests.
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
    // Persist the real town UUID so alarm/internal calls use the correct ID
    if (rigConfig.townId) {
      await this.setTownId(rigConfig.townId);
    }
    await this.ctx.storage.put(`rig:${rigConfig.rigId}:config`, rigConfig);

    // Store kilocodeToken in town config so it's available to all agents
    // (including the mayor) without needing a rig config lookup.
    if (rigConfig.kilocodeToken) {
      const townConfig = await this.getTownConfig();
      if (!townConfig.kilocode_token) {
        console.log(`${TOWN_LOG} configureRig: propagating kilocodeToken to town config`);
        await this.updateTownConfig({ kilocode_token: rigConfig.kilocodeToken });
      }
    }

    // Persist the KILOCODE_TOKEN directly on the TownContainerDO so it's
    // in the container's OS environment (process.env). This is the most
    // reliable path — doesn't depend on X-Town-Config or request body envVars.
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

    // Proactively start the container so it's warm when the user sends
    // their first message. The alarm also keeps it warm on subsequent ticks.
    console.log(`${TOWN_LOG} configureRig: proactively starting container`);
    await this.armAlarmIfNeeded();
    try {
      const container = getTownContainerStub(this.env, this.townId);
      await container.fetch('http://container/health');
    } catch {
      // Container may take a moment to start — the alarm will retry
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
    return beads.createBead(this.sql, input);
  }

  async getBeadAsync(beadId: string): Promise<Bead | null> {
    await this.ensureInitialized();
    return beads.getBead(this.sql, beadId);
  }

  async listBeads(filter: BeadFilter): Promise<Bead[]> {
    await this.ensureInitialized();
    return beads.listBeads(this.sql, filter);
  }

  async updateBeadStatus(beadId: string, status: string, agentId: string): Promise<Bead> {
    await this.ensureInitialized();
    const bead = beads.updateBeadStatus(this.sql, beadId, status, agentId);

    // If closed and has convoy, notify
    if (status === 'closed' && bead.convoy_id) {
      this.onBeadClosed({ convoyId: bead.convoy_id, beadId }).catch(() => {});
    }

    return bead;
  }

  async closeBead(beadId: string, agentId: string): Promise<Bead> {
    return this.updateBeadStatus(beadId, 'closed', agentId);
  }

  async deleteBead(beadId: string): Promise<void> {
    await this.ensureInitialized();
    beads.deleteBead(this.sql, beadId);
  }

  async listBeadEvents(options: {
    beadId?: string;
    since?: string;
    limit?: number;
  }): Promise<RigBeadEventRecord[]> {
    await this.ensureInitialized();
    return beads.listBeadEvents(this.sql, options);
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
    // Clean up agent event storage
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
    status: 'merged' | 'failed';
    message?: string;
    commit_sha?: string;
  }): Promise<void> {
    await this.ensureInitialized();
    reviewQueue.completeReviewWithResult(this.sql, input);
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
    // When agentId is empty (e.g. mayor completion callback without explicit ID),
    // fall back to the mayor agent.
    let resolvedAgentId = agentId;
    if (!resolvedAgentId) {
      const mayor = agents.listAgents(this.sql, { role: 'mayor' })[0];
      if (mayor) resolvedAgentId = mayor.id;
    }
    if (resolvedAgentId) {
      reviewQueue.agentCompleted(this.sql, resolvedAgentId, input);
    }
  }

  async createMolecule(beadId: string, formula: unknown): Promise<RigMoleculeRecord> {
    await this.ensureInitialized();
    return reviewQueue.createMolecule(this.sql, beadId, formula);
  }

  async getMoleculeCurrentStep(
    agentId: string
  ): Promise<{ molecule: RigMoleculeRecord; step: unknown } | null> {
    await this.ensureInitialized();
    return reviewQueue.getMoleculeCurrentStep(this.sql, agentId);
  }

  async advanceMoleculeStep(agentId: string, summary: string): Promise<RigMoleculeRecord | null> {
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
  }): Promise<{ bead: Bead; agent: Agent }> {
    await this.ensureInitialized();

    const createdBead = beads.createBead(this.sql, {
      type: 'issue',
      title: input.title,
      body: input.body,
      priority: (input.priority as 'low' | 'medium' | 'high' | 'critical') ?? 'medium',
    });

    const agent = agents.getOrCreateAgent(this.sql, 'polecat', input.rigId, this.townId);
    agents.hookBead(this.sql, agent.id, createdBead.id);

    // Re-read bead and agent after hook (hookBead updates both)
    const bead = beads.getBead(this.sql, createdBead.id) ?? createdBead;
    const hookedAgent = agents.getAgent(this.sql, agent.id) ?? agent;

    await this.armAlarmIfNeeded();
    return { bead, agent: hookedAgent };
  }

  // ══════════════════════════════════════════════════════════════════
  // Mayor (just another agent)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Send a message to the mayor agent. Creates the mayor if it doesn't exist.
   * The mayor is tracked as an agent with role='mayor'.
   */
  async sendMayorMessage(
    message: string
  ): Promise<{ agentId: string; sessionStatus: 'idle' | 'active' | 'starting' }> {
    await this.ensureInitialized();
    const townId = this.townId;

    // Find or create the mayor agent
    let mayor = agents.listAgents(this.sql, { role: 'mayor' })[0] ?? null;
    if (!mayor) {
      const identity = `mayor-${townId.slice(0, 8)}`;
      mayor = agents.registerAgent(this.sql, {
        role: 'mayor',
        name: 'mayor',
        identity,
      });
    }

    // Check if mayor session is alive in container
    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, townId, mayor.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';

    console.log(
      `${TOWN_LOG} sendMayorMessage: townId=${townId} mayorId=${mayor.id} containerStatus=${containerStatus.status} isAlive=${isAlive}`
    );

    let sessionStatus: 'idle' | 'active' | 'starting';

    // TODO: If we start the container early, then isAlive will be true and we won't get the all the configs
    // BUT also TODO, we're supposed to be sending configs on each request to any agent anyway
    if (isAlive) {
      // Send follow-up message
      await dispatch.sendMessageToAgent(this.env, townId, mayor.id, message);
      sessionStatus = 'active';
    } else {
      // Start a new mayor session
      const townConfig = await this.getTownConfig();
      // TODO: What is a Mayor Rig Config?
      const rigConfig = await this.getMayorRigConfig();
      const kilocodeToken = await this.resolveKilocodeToken();

      console.log(
        `${TOWN_LOG} sendMayorMessage: townId=${townId} hasRigConfig=${!!rigConfig} hasKilocodeToken=${!!kilocodeToken} townConfigToken=${!!townConfig.kilocode_token} rigConfigToken=${!!rigConfig?.kilocodeToken}`
      );

      // Ensure the container has the token in its OS env
      if (kilocodeToken) {
        try {
          const containerStub = getTownContainerStub(this.env, townId);
          await containerStub.setEnvVar('KILOCODE_TOKEN', kilocodeToken);
        } catch {
          // Best effort
        }
      }

      await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
        townId,
        rigId: `mayor-${townId}`,
        userId: townConfig.owner_user_id ?? rigConfig?.userId ?? '',
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
      });

      agents.updateAgentStatus(this.sql, mayor.id, 'working');
      sessionStatus = 'starting';
    }

    await this.armAlarmIfNeeded();
    return { agentId: mayor.id, sessionStatus };
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

    // Map agent status to the session status the frontend expects
    const mapStatus = (agentStatus: string): 'idle' | 'active' | 'starting' => {
      switch (agentStatus) {
        case 'working':
          return 'active';
        case 'blocked':
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
            sessionId: mayor.id, // No separate session concept — use agentId
            status: mapStatus(mayor.status),
            lastActivityAt: mayor.last_activity_at ?? mayor.created_at,
          }
        : null,
    };
  }

  private async getMayorRigConfig(): Promise<RigConfig | null> {
    // Mayor uses the first rig's config for git URL and credentials
    const rigList = rigs.listRigs(this.sql);
    if (rigList.length === 0) return null;
    return this.getRigConfig(rigList[0].id);
  }

  /**
   * Resolve the kilocode token from any available source.
   * Checks: town config → all rig configs (in order).
   */
  private async resolveKilocodeToken(): Promise<string | undefined> {
    // 1. Town config (preferred — single source of truth)
    const townConfig = await this.getTownConfig();
    if (townConfig.kilocode_token) return townConfig.kilocode_token;

    // 2. Scan all rig configs for a token
    const rigList = rigs.listRigs(this.sql);
    for (const rig of rigList) {
      const rc = await this.getRigConfig(rig.id);
      if (rc?.kilocodeToken) {
        // Propagate to town config for next time
        await this.updateTownConfig({ kilocode_token: rc.kilocodeToken });
        return rc.kilocodeToken;
      }
    }

    return undefined;
  }

  // ══════════════════════════════════════════════════════════════════
  // Convoys
  // ══════════════════════════════════════════════════════════════════

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
          ${town_convoys.columns.id}, ${town_convoys.columns.title},
          ${town_convoys.columns.status}, ${town_convoys.columns.total_beads},
          ${town_convoys.columns.closed_beads}, ${town_convoys.columns.created_by},
          ${town_convoys.columns.created_at}, ${town_convoys.columns.landed_at}
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
            ${town_convoy_beads.columns.convoy_id}, ${town_convoy_beads.columns.bead_id},
            ${town_convoy_beads.columns.rig_id}, ${town_convoy_beads.columns.status}
          ) VALUES (?, ?, ?, ?)
        `,
        [convoyId, bead.bead_id, bead.rig_id, 'open']
      );
    }

    const convoy = this.getConvoy(convoyId);
    if (!convoy) throw new Error('Failed to create convoy');
    return convoy;
  }

  async onBeadClosed(input: {
    convoyId: string;
    beadId: string;
  }): Promise<TownConvoyRecord | null> {
    await this.ensureInitialized();

    query(
      this.sql,
      /* sql */ `
        UPDATE ${town_convoy_beads}
        SET ${town_convoy_beads.columns.status} = ?
        WHERE ${town_convoy_beads.columns.convoy_id} = ? AND ${town_convoy_beads.columns.bead_id} = ?
          AND ${town_convoy_beads.columns.status} != ?
      `,
      ['closed', input.convoyId, input.beadId, 'closed']
    );

    const closedRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(1) AS count FROM ${town_convoy_beads} WHERE ${town_convoy_beads.columns.convoy_id} = ? AND ${town_convoy_beads.columns.status} = ?`,
        [input.convoyId, 'closed']
      ),
    ];
    const closedCount = z.object({ count: z.number() }).parse(closedRows[0] ?? { count: 0 }).count;

    query(
      this.sql,
      /* sql */ `UPDATE ${town_convoys} SET ${town_convoys.columns.closed_beads} = ? WHERE ${town_convoys.columns.id} = ?`,
      [closedCount, input.convoyId]
    );

    const convoy = this.getConvoy(input.convoyId);
    if (convoy && convoy.status === 'active' && convoy.closed_beads >= convoy.total_beads) {
      query(
        this.sql,
        /* sql */ `UPDATE ${town_convoys} SET ${town_convoys.columns.status} = ?, ${town_convoys.columns.landed_at} = ? WHERE ${town_convoys.columns.id} = ?`,
        ['landed', now(), input.convoyId]
      );
      return this.getConvoy(input.convoyId);
    }
    return convoy;
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

  // ══════════════════════════════════════════════════════════════════
  // Escalations
  // ══════════════════════════════════════════════════════════════════

  async acknowledgeEscalation(escalationId: string): Promise<TownEscalationRecord | null> {
    await this.ensureInitialized();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${town_escalations}
        SET ${town_escalations.columns.acknowledged} = 1, ${town_escalations.columns.acknowledged_at} = ?
        WHERE ${town_escalations.columns.id} = ? AND ${town_escalations.columns.acknowledged} = 0
      `,
      [now(), escalationId]
    );
    return this.getEscalation(escalationId);
  }

  async listEscalations(filter?: { acknowledged?: boolean }): Promise<TownEscalationRecord[]> {
    await this.ensureInitialized();
    const rows =
      filter?.acknowledged !== undefined
        ? [
            ...query(
              this.sql,
              /* sql */ `SELECT * FROM ${town_escalations} WHERE ${town_escalations.columns.acknowledged} = ? ORDER BY ${town_escalations.columns.created_at} DESC LIMIT 100`,
              [filter.acknowledged ? 1 : 0]
            ),
          ]
        : [
            ...query(
              this.sql,
              /* sql */ `SELECT * FROM ${town_escalations} ORDER BY ${town_escalations.columns.created_at} DESC LIMIT 100`,
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
    const id = generateId();
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${town_escalations} (
          ${town_escalations.columns.id}, ${town_escalations.columns.source_rig_id},
          ${town_escalations.columns.source_agent_id}, ${town_escalations.columns.severity},
          ${town_escalations.columns.category}, ${town_escalations.columns.message},
          ${town_escalations.columns.acknowledged}, ${town_escalations.columns.re_escalation_count},
          ${town_escalations.columns.created_at}, ${town_escalations.columns.acknowledged_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.source_rig_id,
        input.source_agent_id ?? null,
        input.severity,
        input.category ?? null,
        input.message,
        0,
        0,
        now(),
        null,
      ]
    );

    const escalation = this.getEscalation(id);
    if (!escalation) throw new Error('Failed to create escalation');

    // Notify mayor for medium+ severity
    if (input.severity !== 'low') {
      this.sendMayorMessage(
        `[Escalation:${input.severity}] rig=${input.source_rig_id} ${input.message}`
      ).catch(err => console.warn(`${TOWN_LOG} routeEscalation: failed to notify mayor:`, err));
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

  // ══════════════════════════════════════════════════════════════════
  // Alarm (Scheduler + Witness Patrol + Review Queue)
  // ══════════════════════════════════════════════════════════════════

  async alarm(): Promise<void> {
    await this.ensureInitialized();
    const townId = this.townId;
    if (!townId) {
      console.warn(`${TOWN_LOG} alarm: missing townId; skipping`);
      return;
    }

    console.log(`${TOWN_LOG} alarm: fired for town=${townId}`);

    // Only proactively wake the container if rigs are configured.
    // Without rigs there's no git repo to work with, so no point keeping
    // the container warm. On-demand starts (sendMayorMessage, slingBead)
    // still work regardless.
    const hasRigs = rigs.listRigs(this.sql).length > 0;
    if (hasRigs) {
      try {
        await this.ensureContainerReady();
      } catch (err) {
        console.warn(`${TOWN_LOG} alarm: container health check failed`, err);
      }
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
      await this.processReviewQueue();
    } catch (err) {
      console.error(`${TOWN_LOG} alarm: processReviewQueue failed`, err);
    }
    try {
      await this.reEscalateStaleEscalations();
    } catch (err) {
      console.warn(`${TOWN_LOG} alarm: reEscalation failed`, err);
    }

    // Re-arm: fast when active, slow when idle
    const active = this.hasActiveWork();
    const interval = active ? ACTIVE_ALARM_INTERVAL_MS : IDLE_ALARM_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Date.now() + interval);
  }

  private hasActiveWork(): boolean {
    const activeAgentRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${rig_agents} WHERE ${rig_agents.columns.status} IN ('working', 'blocked')`,
        []
      ),
    ];
    const pendingBeadRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${rig_agents} WHERE ${rig_agents.columns.status} = 'idle' AND ${rig_agents.columns.current_hook_bead_id} IS NOT NULL`,
        []
      ),
    ];
    const pendingReviewRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${rig_review_queue} WHERE ${rig_review_queue.columns.status} IN ('pending', 'running')`,
        []
      ),
    ];
    return (
      Number(activeAgentRows[0]?.cnt ?? 0) > 0 ||
      Number(pendingBeadRows[0]?.cnt ?? 0) > 0 ||
      Number(pendingReviewRows[0]?.cnt ?? 0) > 0
    );
  }

  /**
   * Find idle agents with hooked beads and dispatch them to the container.
   */
  private async schedulePendingWork(): Promise<void> {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${rig_agents} WHERE ${rig_agents.columns.status} = 'idle' AND ${rig_agents.columns.current_hook_bead_id} IS NOT NULL`,
        []
      ),
    ];
    const pendingAgents = RigAgentRecord.array().parse(rows);
    console.log(`${TOWN_LOG} schedulePendingWork: found ${pendingAgents.length} pending agents`);
    if (pendingAgents.length === 0) return;

    const townConfig = await this.getTownConfig();
    const kilocodeToken = await this.resolveKilocodeToken();

    // Build dispatch tasks for all pending agents, then run in parallel
    const dispatchTasks: Array<() => Promise<void>> = [];

    for (const agent of pendingAgents) {
      const beadId = agent.current_hook_bead_id;
      if (!beadId) continue;
      const bead = beads.getBead(this.sql, beadId);
      if (!bead) continue;

      // Circuit breaker
      const attempts = agent.dispatch_attempts + 1;
      if (attempts > MAX_DISPATCH_ATTEMPTS) {
        beads.updateBeadStatus(this.sql, beadId, 'failed', agent.id);
        agents.unhookBead(this.sql, agent.id);
        continue;
      }

      // Increment dispatch attempts
      query(
        this.sql,
        /* sql */ `UPDATE ${rig_agents} SET ${rig_agents.columns.dispatch_attempts} = ? WHERE ${rig_agents.columns.id} = ?`,
        [attempts, agent.id]
      );

      // Use the agent's rig_id to get the correct rig config
      const rigId = agent.rig_id ?? rigs.listRigs(this.sql)[0]?.id ?? '';
      const rigConfig = rigId ? await this.getRigConfig(rigId) : null;

      console.log(
        `${TOWN_LOG} schedulePendingWork: agent=${agent.name}(${agent.id}) rig_id=${agent.rig_id ?? 'null'} resolved_rig=${rigId} hasConfig=${!!rigConfig}`
      );

      if (!rigConfig) {
        console.warn(
          `${TOWN_LOG} schedulePendingWork: no rig config for agent=${agent.id} rig=${rigId}`
        );
        continue;
      }

      dispatchTasks.push(async () => {
        const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
          townId: this.townId,
          rigId,
          userId: rigConfig.userId,
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          identity: agent.identity,
          beadId,
          beadTitle: bead.title,
          beadBody: bead.body ?? '',
          checkpoint: agent.checkpoint,
          gitUrl: rigConfig.gitUrl,
          defaultBranch: rigConfig.defaultBranch,
          kilocodeToken,
          townConfig,
        });

        if (started) {
          query(
            this.sql,
            /* sql */ `UPDATE ${rig_agents} SET ${rig_agents.columns.status} = 'working', ${rig_agents.columns.dispatch_attempts} = 0, ${rig_agents.columns.last_activity_at} = ? WHERE ${rig_agents.columns.id} = ?`,
            [now(), agent.id]
          );
        }
      });
    }

    // Dispatch all agents in parallel
    if (dispatchTasks.length > 0) {
      await Promise.allSettled(dispatchTasks.map(fn => fn()));
    }
  }

  /**
   * Witness patrol: detect dead/stale agents, orphaned beads.
   */
  private async witnessPatrol(): Promise<void> {
    const townId = this.townId;
    const guppThreshold = new Date(Date.now() - GUPP_THRESHOLD_MS).toISOString();

    const AgentPick = RigAgentRecord.pick({
      id: true,
      current_hook_bead_id: true,
      last_activity_at: true,
    });
    const workingAgents = AgentPick.array().parse([
      ...query(
        this.sql,
        /* sql */ `SELECT ${rig_agents.columns.id}, ${rig_agents.columns.current_hook_bead_id}, ${rig_agents.columns.last_activity_at} FROM ${rig_agents} WHERE ${rig_agents.columns.status} IN ('working', 'blocked')`,
        []
      ),
    ]);

    for (const working of workingAgents) {
      const containerInfo = await dispatch.checkAgentContainerStatus(this.env, townId, working.id);

      if (containerInfo.status === 'not_found' || containerInfo.status === 'exited') {
        if (containerInfo.exitReason === 'completed') {
          reviewQueue.agentCompleted(this.sql, working.id, { status: 'completed' });
          continue;
        }
        // Reset to idle for re-dispatch
        query(
          this.sql,
          /* sql */ `UPDATE ${rig_agents} SET ${rig_agents.columns.status} = 'idle', ${rig_agents.columns.last_activity_at} = ? WHERE ${rig_agents.columns.id} = ?`,
          [now(), working.id]
        );
        continue;
      }

      // GUPP violation check
      if (working.last_activity_at && working.last_activity_at < guppThreshold) {
        const MailId = z.object({ id: z.string() });
        const existingGupp = MailId.array().parse([
          ...query(
            this.sql,
            /* sql */ `SELECT ${rig_mail.columns.id} FROM ${rig_mail} WHERE ${rig_mail.columns.to_agent_id} = ? AND ${rig_mail.columns.subject} = 'GUPP_CHECK' AND ${rig_mail.columns.delivered} = 0 LIMIT 1`,
            [working.id]
          ),
        ]);
        if (existingGupp.length === 0) {
          mail.sendMail(this.sql, {
            from_agent_id: 'witness',
            to_agent_id: working.id,
            subject: 'GUPP_CHECK',
            body: 'You have had work hooked for 30+ minutes with no activity. Are you stuck? If so, call gt_escalate.',
          });
        }
      }
    }
  }

  /**
   * Process the review queue: pop pending entries and trigger merge.
   */
  private async processReviewQueue(): Promise<void> {
    reviewQueue.recoverStuckReviews(this.sql);

    const entry = reviewQueue.popReviewQueue(this.sql);
    if (!entry) return;

    // OPEN QUESTION: Same as schedulePendingWork — need rig_id on agents or review_queue
    const rigList = rigs.listRigs(this.sql);
    const rigId = rigList[0]?.id ?? '';
    const rigConfig = await this.getRigConfig(rigId);
    if (!rigConfig) return;

    const townConfig = await this.getTownConfig();
    const gates = townConfig.refinery?.gates ?? [];

    if (gates.length > 0) {
      // Dispatch refinery agent
      const refineryAgent = agents.getOrCreateAgent(this.sql, 'refinery', rigId, this.townId);

      const { buildRefinerySystemPrompt } = await import('../prompts/refinery-system.prompt');
      const systemPrompt = buildRefinerySystemPrompt({
        identity: refineryAgent.identity,
        rigId,
        townId: this.townId,
        gates,
        branch: entry.branch,
        targetBranch: rigConfig.defaultBranch,
        polecatAgentId: entry.agent_id,
      });

      agents.hookBead(this.sql, refineryAgent.id, entry.bead_id);

      const started = await dispatch.startAgentInContainer(this.env, this.ctx.storage, {
        townId: this.townId,
        rigId,
        userId: rigConfig.userId,
        agentId: refineryAgent.id,
        agentName: refineryAgent.name,
        role: 'refinery',
        identity: refineryAgent.identity,
        beadId: entry.bead_id,
        beadTitle: `Review merge: ${entry.branch} → ${rigConfig.defaultBranch}`,
        beadBody: entry.summary ?? '',
        checkpoint: null,
        gitUrl: rigConfig.gitUrl,
        defaultBranch: rigConfig.defaultBranch,
        kilocodeToken: rigConfig.kilocodeToken,
        townConfig,
        systemPromptOverride: systemPrompt,
      });

      if (!started) {
        agents.unhookBead(this.sql, refineryAgent.id);
        // Fallback to deterministic merge
        await this.triggerDeterministicMerge(rigConfig, entry, townConfig);
      }
    } else {
      await this.triggerDeterministicMerge(rigConfig, entry, townConfig);
    }
  }

  private async triggerDeterministicMerge(
    rigConfig: RigConfig,
    entry: ReviewQueueEntry,
    townConfig: TownConfig
  ): Promise<void> {
    const ok = await dispatch.startMergeInContainer(this.env, this.ctx.storage, {
      townId: this.townId,
      rigId: rigConfig.rigId,
      agentId: entry.agent_id,
      entryId: entry.id,
      beadId: entry.bead_id,
      branch: entry.branch,
      targetBranch: rigConfig.defaultBranch,
      gitUrl: rigConfig.gitUrl,
      kilocodeToken: rigConfig.kilocodeToken,
      townConfig,
    });
    if (!ok) {
      reviewQueue.completeReview(this.sql, entry.id, 'failed');
    }
  }

  /**
   * Bump severity of stale unacknowledged escalations.
   */
  private async reEscalateStaleEscalations(): Promise<void> {
    const candidates = TownEscalationRecord.array().parse([
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${town_escalations} WHERE ${town_escalations.columns.acknowledged} = 0 AND ${town_escalations.columns.re_escalation_count} < ?`,
        [MAX_RE_ESCALATIONS]
      ),
    ]);

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
        /* sql */ `UPDATE ${town_escalations} SET ${town_escalations.columns.severity} = ?, ${town_escalations.columns.re_escalation_count} = ${town_escalations.columns.re_escalation_count} + 1 WHERE ${town_escalations.columns.id} = ?`,
        [newSeverity, esc.id]
      );

      if (newSeverity !== 'low') {
        this.sendMayorMessage(
          `[Re-Escalation:${newSeverity}] rig=${esc.source_rig_id} ${esc.message}`
        ).catch(() => {});
      }
    }
  }

  /**
   * Proactive container health check.
   * Pings the container if there's active work OR if the container was
   * recently started (within the first few minutes after rig configuration).
   */
  private async ensureContainerReady(): Promise<void> {
    const hasRigs = rigs.listRigs(this.sql).length > 0;
    if (!hasRigs) return;

    // Always keep container warm if there's active work
    // Also keep it warm for the first 5 minutes after a rig is configured
    // (the container may still be warming up for the user's first interaction)
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

  async destroy(): Promise<void> {
    console.log(`${TOWN_LOG} destroy: clearing all storage and alarms`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export function getTownDOStub(env: Env, townId: string) {
  return env.TOWN.get(env.TOWN.idFromName(townId));
}
