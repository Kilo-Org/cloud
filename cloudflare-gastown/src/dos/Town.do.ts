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

// Table imports for beads-centric operations
import { beads } from '../db/tables/beads.table';
import { agent_metadata } from '../db/tables/agent-metadata.table';
import {
  escalation_metadata,
  EscalationMetadataRecord,
} from '../db/tables/escalation-metadata.table';
import { convoy_metadata, ConvoyMetadataRecord } from '../db/tables/convoy-metadata.table';
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
} from '../types';

const TOWN_LOG = '[Town.do]';

// Alarm intervals
const ACTIVE_ALARM_INTERVAL_MS = 15_000; // 15s when agents are active
const IDLE_ALARM_INTERVAL_MS = 5 * 60_000; // 5m when idle
const GUPP_THRESHOLD_MS = 30 * 60_000; // 30 min
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
};

// ── Escalation helper type (bead + escalation_metadata) ─────────────
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

function parseEscalation(row: Record<string, unknown>): EscalationEntry {
  return {
    id: String(row.bead_id),
    source_rig_id: String(row.rig_id ?? ''),
    source_agent_id: row.created_by === null ? null : String(row.created_by),
    severity: EscalationMetadataRecord.shape.severity.parse(row.severity),
    category: row.category === null ? null : String(row.category),
    message: String(row.body ?? row.title ?? ''),
    acknowledged: Number(row.acknowledged ?? 0),
    re_escalation_count: Number(row.re_escalation_count ?? 0),
    created_at: String(row.created_at),
    acknowledged_at: row.acknowledged_at === null ? null : String(row.acknowledged_at),
  };
}

// ── Convoy helper type (bead + convoy_metadata) ─────────────────────
type ConvoyEntry = {
  id: string;
  title: string;
  status: 'active' | 'landed';
  total_beads: number;
  closed_beads: number;
  created_by: string | null;
  created_at: string;
  landed_at: string | null;
};

function parseConvoy(row: Record<string, unknown>): ConvoyEntry {
  return {
    id: String(row.bead_id),
    title: String(row.title),
    status: row.bead_status === 'closed' ? 'landed' : 'active',
    total_beads: Number(row.total_beads ?? 0),
    closed_beads: Number(row.closed_beads ?? 0),
    created_by: row.created_by === null ? null : String(row.created_by),
    created_at: String(row.created_at),
    landed_at: row.landed_at === null ? null : String(row.landed_at),
  };
}

const CONVOY_JOIN = /* sql */ `
  SELECT ${beads.bead_id}, ${beads.title}, ${beads.status} AS bead_status,
         ${beads.created_by}, ${beads.created_at},
         ${convoy_metadata.total_beads}, ${convoy_metadata.closed_beads},
         ${convoy_metadata.landed_at}
  FROM ${beads}
  INNER JOIN ${convoy_metadata} ON ${beads.bead_id} = ${convoy_metadata.bead_id}
`;

const ESCALATION_JOIN = /* sql */ `
  SELECT ${beads.bead_id}, ${beads.rig_id}, ${beads.title}, ${beads.body},
         ${beads.created_by}, ${beads.created_at},
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
    // Delete agents belonging to this rig
    query(
      this.sql,
      /* sql */ `
        DELETE FROM ${agent_metadata}
        WHERE ${agent_metadata.columns.bead_id} IN (
          SELECT ${beads.columns.bead_id} FROM ${beads}
          WHERE ${beads.columns.type} = 'agent' AND ${beads.columns.rig_id} = ?
        )
      `,
      [rigId]
    );
    query(this.sql, /* sql */ `DELETE FROM ${beads} WHERE ${beads.columns.rig_id} = ?`, [rigId]);
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
    const bead = beadOps.updateBeadStatus(this.sql, beadId, status, agentId);

    // If closed and part of a convoy (via bead_dependencies), notify
    if (status === 'closed') {
      const convoyRows = [
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${bead_dependencies.depends_on_bead_id}
            FROM ${bead_dependencies}
            WHERE ${bead_dependencies.bead_id} = ?
              AND ${bead_dependencies.dependency_type} = 'tracks'
          `,
          [beadId]
        ),
      ];
      for (const row of convoyRows) {
        const convoyId = String((row as Record<string, unknown>).depends_on_bead_id);
        this.onBeadClosed({ convoyId, beadId }).catch(() => {});
      }
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
    let resolvedAgentId = agentId;
    if (!resolvedAgentId) {
      const mayor = agents.listAgents(this.sql, { role: 'mayor' })[0];
      if (mayor) resolvedAgentId = mayor.id;
    }
    if (resolvedAgentId) {
      reviewQueue.agentCompleted(this.sql, resolvedAgentId, input);
    }
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

    await this.armAlarmIfNeeded();
    return { bead, agent: hookedAgent };
  }

  // ══════════════════════════════════════════════════════════════════
  // Mayor (just another agent)
  // ══════════════════════════════════════════════════════════════════

  async sendMayorMessage(
    message: string,
    model?: string
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
        WHERE ${convoy_metadata.columns.bead_id} = ?
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
          WHERE ${beads.columns.bead_id} = ?
        `,
        [timestamp, timestamp, input.convoyId]
      );
      query(
        this.sql,
        /* sql */ `
          UPDATE ${convoy_metadata}
          SET ${convoy_metadata.columns.landed_at} = ?
          WHERE ${convoy_metadata.columns.bead_id} = ?
        `,
        [timestamp, input.convoyId]
      );
      return this.getConvoy(input.convoyId);
    }
    return convoy;
  }

  private getConvoy(convoyId: string): ConvoyEntry | null {
    const rows = [
      ...query(this.sql, /* sql */ `${CONVOY_JOIN} WHERE ${beads.bead_id} = ?`, [convoyId]),
    ];
    if (rows.length === 0) return null;
    return parseConvoy(rows[0] as Record<string, unknown>);
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
        WHERE ${escalation_metadata.columns.bead_id} = ? AND ${escalation_metadata.columns.acknowledged} = 0
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
    return rows.map(r => parseEscalation(r as Record<string, unknown>));
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
        '{}',
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

    // Notify mayor for medium+ severity
    if (input.severity !== 'low') {
      this.sendMayorMessage(
        `[Escalation:${input.severity}] rig=${input.source_rig_id} ${input.message}`
      ).catch(err => console.warn(`${TOWN_LOG} routeEscalation: failed to notify mayor:`, err));
    }

    return escalation;
  }

  private getEscalation(escalationId: string): EscalationEntry | null {
    const rows = [
      ...query(this.sql, /* sql */ `${ESCALATION_JOIN} WHERE ${beads.bead_id} = ?`, [escalationId]),
    ];
    if (rows.length === 0) return null;
    return parseEscalation(rows[0] as Record<string, unknown>);
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
        /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata} WHERE ${agent_metadata.columns.status} IN ('working', 'stalled')`,
        []
      ),
    ];
    const pendingBeadRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata} WHERE ${agent_metadata.columns.status} = 'idle' AND ${agent_metadata.columns.current_hook_bead_id} IS NOT NULL`,
        []
      ),
    ];
    const pendingReviewRows = [
      ...query(
        this.sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${beads} WHERE ${beads.columns.type} = 'merge_request' AND ${beads.columns.status} IN ('open', 'in_progress')`,
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
        /* sql */ `
          SELECT ${beads.bead_id}, ${beads.rig_id}, ${beads.title}, ${beads.created_at},
                 ${agent_metadata.role}, ${agent_metadata.identity},
                 ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
                 ${agent_metadata.dispatch_attempts}, ${agent_metadata.last_activity_at},
                 ${agent_metadata.checkpoint}
          FROM ${beads}
          INNER JOIN ${agent_metadata} ON ${beads.bead_id} = ${agent_metadata.bead_id}
          WHERE ${agent_metadata.status} = 'idle' AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
        `,
        []
      ),
    ];
    const pendingAgents: Agent[] = rows.map(r => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.bead_id),
        rig_id: row.rig_id === null ? null : String(row.rig_id),
        role: String(row.role) as Agent['role'],
        name: String(row.title),
        identity: String(row.identity),
        status: String(row.status) as Agent['status'],
        current_hook_bead_id:
          row.current_hook_bead_id === null ? null : String(row.current_hook_bead_id),
        dispatch_attempts: Number(row.dispatch_attempts ?? 0),
        last_activity_at: row.last_activity_at === null ? null : String(row.last_activity_at),
        checkpoint: row.checkpoint === null ? null : JSON.parse(String(row.checkpoint)),
        created_at: String(row.created_at),
      };
    });

    console.log(`${TOWN_LOG} schedulePendingWork: found ${pendingAgents.length} pending agents`);
    if (pendingAgents.length === 0) return;

    const townConfig = await this.getTownConfig();
    const kilocodeToken = await this.resolveKilocodeToken();
    const rigList = rigs.listRigs(this.sql);

    const dispatchTasks: Array<() => Promise<void>> = [];

    for (const agent of pendingAgents) {
      const beadId = agent.current_hook_bead_id;
      if (!beadId) continue;
      const bead = beadOps.getBead(this.sql, beadId);
      if (!bead) continue;

      const attempts = agent.dispatch_attempts + 1;
      if (attempts > MAX_DISPATCH_ATTEMPTS) {
        beadOps.updateBeadStatus(this.sql, beadId, 'failed', agent.id);
        agents.unhookBead(this.sql, agent.id);
        continue;
      }

      const rigId = agent.rig_id ?? rigList[0]?.id ?? '';
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

      query(
        this.sql,
        /* sql */ `UPDATE ${agent_metadata} SET ${agent_metadata.columns.dispatch_attempts} = ? WHERE ${agent_metadata.columns.bead_id} = ?`,
        [attempts, agent.id]
      );

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
            /* sql */ `UPDATE ${agent_metadata} SET ${agent_metadata.columns.status} = 'working', ${agent_metadata.columns.dispatch_attempts} = 0, ${agent_metadata.columns.last_activity_at} = ? WHERE ${agent_metadata.columns.bead_id} = ?`,
            [now(), agent.id]
          );
        }
      });
    }

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

    const workingAgents = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agent_metadata.bead_id}, ${agent_metadata.current_hook_bead_id}, ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
          WHERE ${agent_metadata.status} IN ('working', 'stalled')
        `,
        []
      ),
    ];

    for (const row of workingAgents) {
      const working = row as Record<string, unknown>;
      const agentId = String(working.bead_id);
      const hookBeadId =
        working.current_hook_bead_id === null ? null : String(working.current_hook_bead_id);
      const lastActivity =
        working.last_activity_at === null ? null : String(working.last_activity_at);

      const containerInfo = await dispatch.checkAgentContainerStatus(this.env, townId, agentId);

      if (containerInfo.status === 'not_found' || containerInfo.status === 'exited') {
        if (containerInfo.exitReason === 'completed') {
          reviewQueue.agentCompleted(this.sql, agentId, { status: 'completed' });
          continue;
        }
        query(
          this.sql,
          /* sql */ `UPDATE ${agent_metadata} SET ${agent_metadata.columns.status} = 'idle', ${agent_metadata.columns.last_activity_at} = ? WHERE ${agent_metadata.columns.bead_id} = ?`,
          [now(), agentId]
        );
        continue;
      }

      // GUPP violation check
      if (lastActivity && lastActivity < guppThreshold) {
        // Check for existing GUPP mail
        const existingGupp = [
          ...query(
            this.sql,
            /* sql */ `
              SELECT ${beads.bead_id} FROM ${beads}
              WHERE ${beads.columns.type} = 'message'
                AND ${beads.columns.assignee_agent_bead_id} = ?
                AND ${beads.columns.title} = 'GUPP_CHECK'
                AND ${beads.columns.status} = 'open'
              LIMIT 1
            `,
            [agentId]
          ),
        ];
        if (existingGupp.length === 0) {
          mail.sendMail(this.sql, {
            from_agent_id: 'witness',
            to_agent_id: agentId,
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

    const rigList = rigs.listRigs(this.sql);
    const rigId = rigList[0]?.id ?? '';
    const rigConfig = await this.getRigConfig(rigId);
    if (!rigConfig) {
      reviewQueue.completeReview(this.sql, entry.id, 'failed');
      return;
    }

    const townConfig = await this.getTownConfig();
    const gates = townConfig.refinery?.gates ?? [];

    if (gates.length > 0) {
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
    const candidates = [
      ...query(
        this.sql,
        /* sql */ `${ESCALATION_JOIN} WHERE ${escalation_metadata.acknowledged} = 0 AND ${escalation_metadata.re_escalation_count} < ?`,
        [MAX_RE_ESCALATIONS]
      ),
    ].map(r => parseEscalation(r as Record<string, unknown>));

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
          WHERE ${escalation_metadata.columns.bead_id} = ?
        `,
        [newSeverity, esc.id]
      );

      if (newSeverity !== 'low') {
        this.sendMayorMessage(
          `[Re-Escalation:${newSeverity}] rig=${esc.source_rig_id} ${esc.message}`
        ).catch(() => {});
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
