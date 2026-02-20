import { DurableObject } from 'cloudflare:workers';
import { getTownContainerStub } from './TownContainer.do';
import { signAgentJWT } from '../util/jwt.util';
import { buildMayorSystemPrompt } from '../prompts/mayor-system.prompt';

const MAYOR_LOG = '[Mayor.do]';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// Re-check session health every 15 seconds while a session exists.
// Primary completion is via the callback; this is a safety net.
const ALARM_INTERVAL_MS = 15_000;

// Mark session stale if no activity for 30 minutes (container may have slept)
const SESSION_STALE_MS = 30 * 60 * 1000;

// KV keys for persistent state
const MAYOR_CONFIG_KEY = 'mayorConfig';
const MAYOR_SESSION_KEY = 'mayorSession';

type MayorConfig = {
  townId: string;
  userId: string;
  kilocodeToken?: string;
  /** Git URL needed for the container to clone the repo */
  gitUrl: string;
  /** Default branch of the rig's repo */
  defaultBranch: string;
};

type MayorSessionStatus = 'idle' | 'active' | 'starting';

type MayorSession = {
  agentId: string;
  sessionId: string;
  status: MayorSessionStatus;
  lastActivityAt: string;
};

type MayorStatus = {
  configured: boolean;
  session: MayorSession | null;
  townId: string | null;
};

/**
 * MayorDO — a town-level Durable Object for the Mayor conversational agent.
 *
 * Keyed by townId. One instance per town. The mayor is a persistent
 * conversational agent that delegates work to Rig DOs via tools.
 *
 * Unlike rig-level agents (which are bead-driven and ephemeral), the
 * mayor maintains a long-lived kilo serve session. User messages are
 * sent as follow-ups to the existing session — no beads are created.
 */
export class MayorDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // ── Configuration ─────────────────────────────────────────────────────

  async configureMayor(config: MayorConfig): Promise<void> {
    console.log(
      `${MAYOR_LOG} configureMayor: townId=${config.townId} userId=${config.userId} gitUrl=${config.gitUrl}`
    );
    await this.ctx.storage.put(MAYOR_CONFIG_KEY, config);
  }

  private async getConfig(): Promise<MayorConfig | null> {
    return (await this.ctx.storage.get<MayorConfig>(MAYOR_CONFIG_KEY)) ?? null;
  }

  // ── Session management ────────────────────────────────────────────────

  private async getSession(): Promise<MayorSession | null> {
    return (await this.ctx.storage.get<MayorSession>(MAYOR_SESSION_KEY)) ?? null;
  }

  private async saveSession(session: MayorSession): Promise<void> {
    await this.ctx.storage.put(MAYOR_SESSION_KEY, session);
  }

  private async clearSession(): Promise<void> {
    await this.ctx.storage.delete(MAYOR_SESSION_KEY);
  }

  // ── Send Message (main RPC) ───────────────────────────────────────────

  /**
   * Send a user message to the mayor. Creates a session on first call,
   * sends a follow-up message on subsequent calls. No beads are created.
   */
  async sendMessage(
    message: string,
    model?: string
  ): Promise<{ agentId: string; sessionStatus: MayorSessionStatus }> {
    const config = await this.getConfig();
    if (!config) {
      throw new Error('MayorDO not configured — call configureMayor first');
    }

    let session = await this.getSession();

    if (session) {
      // Verify existing session is still alive in the container
      const alive = await this.isSessionAlive(config.townId, session.agentId);
      if (!alive) {
        console.log(
          `${MAYOR_LOG} sendMessage: existing session ${session.sessionId} is dead, recreating`
        );
        session = null;
        await this.clearSession();
      }
    }

    if (!session) {
      // First message — create the session
      console.log(`${MAYOR_LOG} sendMessage: no active session, creating new one`);
      session = await this.createSession(config, message, model);
      await this.saveSession(session);
      await this.armAlarm();
      return { agentId: session.agentId, sessionStatus: session.status };
    }

    // Subsequent message — send follow-up to existing session
    console.log(
      `${MAYOR_LOG} sendMessage: sending follow-up to session ${session.sessionId} agent=${session.agentId}`
    );
    try {
      await this.sendFollowUp(config.townId, session.agentId, message);
    } catch (err) {
      // The container may have restarted, losing the agent. Clear the
      // stale session and start fresh rather than surfacing the error.
      console.warn(
        `${MAYOR_LOG} sendMessage: follow-up failed, clearing stale session and recreating`,
        err instanceof Error ? err.message : err
      );
      await this.clearSession();
      session = await this.createSession(config, message, model);
      await this.saveSession(session);
      await this.armAlarm();
      return { agentId: session.agentId, sessionStatus: session.status };
    }
    session = { ...session, status: 'active', lastActivityAt: now() };
    await this.saveSession(session);
    await this.armAlarm();
    return { agentId: session.agentId, sessionStatus: session.status };
  }

  // ── Status ────────────────────────────────────────────────────────────

  async getMayorStatus(): Promise<MayorStatus> {
    const config = await this.getConfig();
    const session = await this.getSession();
    return {
      configured: config !== null,
      session,
      townId: config?.townId ?? null,
    };
  }

  // ── Agent Completion Callback ──────────────────────────────────────────

  /**
   * Called by the container's completion reporter when the mayor agent
   * finishes. Clears the session immediately so the UI reflects idle
   * status without waiting for the next alarm.
   */
  async agentCompleted(
    agentId: string,
    status: 'completed' | 'failed',
    reason?: string
  ): Promise<void> {
    const session = await this.getSession();
    if (!session) {
      console.log(`${MAYOR_LOG} agentCompleted: no active session, ignoring`);
      return;
    }
    if (session.agentId !== agentId) {
      console.log(
        `${MAYOR_LOG} agentCompleted: agentId mismatch (expected ${session.agentId}, got ${agentId}), ignoring`
      );
      return;
    }

    console.log(
      `${MAYOR_LOG} agentCompleted: agent ${agentId} ${status}${reason ? ` (${reason})` : ''}, clearing session`
    );
    await this.clearSession();
    await this.ctx.storage.deleteAlarm();
  }

  // ── Destroy ───────────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    console.log(`${MAYOR_LOG} destroy: clearing all storage and alarms`);
    const config = await this.getConfig();
    const session = await this.getSession();

    // Best-effort: stop the agent in the container
    if (config && session) {
      try {
        const container = getTownContainerStub(this.env, config.townId);
        await container.fetch(`http://container/agents/${session.agentId}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch (err) {
        console.warn(`${MAYOR_LOG} destroy: failed to stop agent in container:`, err);
      }
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ── Alarm ─────────────────────────────────────────────────────────────

  /**
   * Periodic health check. Verifies the mayor session is still alive
   * in the container. If the container died or the session is stale,
   * clears the session so the next sendMessage recreates it.
   */
  async alarm(): Promise<void> {
    console.log(`${MAYOR_LOG} alarm: fired at ${now()}`);
    const config = await this.getConfig();
    const session = await this.getSession();

    if (!config || !session) {
      console.log(`${MAYOR_LOG} alarm: no config or session, not re-arming`);
      return;
    }

    // Check if the session is stale (no activity for SESSION_STALE_MS)
    const lastActivity = new Date(session.lastActivityAt).getTime();
    if (Date.now() - lastActivity > SESSION_STALE_MS) {
      console.log(
        `${MAYOR_LOG} alarm: session ${session.sessionId} is stale (last activity: ${session.lastActivityAt}), stopping agent and clearing`
      );
      await this.bestEffortStopAgent(config.townId, session.agentId);
      await this.clearSession();
      return;
    }

    // Check container health
    const alive = await this.isSessionAlive(config.townId, session.agentId);
    if (!alive) {
      console.log(
        `${MAYOR_LOG} alarm: session ${session.sessionId} agent ${session.agentId} is dead in container, clearing`
      );
      await this.clearSession();
      return;
    }

    // Session is alive and not stale — re-arm
    console.log(`${MAYOR_LOG} alarm: session healthy, re-arming for ${ALARM_INTERVAL_MS}ms`);
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private async armAlarm(): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || currentAlarm < Date.now()) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * Resolve the GASTOWN_JWT_SECRET binding to a string.
   */
  private async resolveJWTSecret(): Promise<string | null> {
    const binding = this.env.GASTOWN_JWT_SECRET;
    if (!binding) return null;
    if (typeof binding === 'string') return binding;
    try {
      return await binding.get();
    } catch {
      console.error(`${MAYOR_LOG} Failed to resolve GASTOWN_JWT_SECRET`);
      return null;
    }
  }

  /**
   * Mint a JWT for the mayor agent to authenticate API calls.
   */
  private async mintMayorToken(agentId: string, config: MayorConfig): Promise<string | null> {
    const secret = await this.resolveJWTSecret();
    if (!secret) return null;

    // Mayor uses a synthetic rigId since it's town-scoped, not rig-scoped
    return signAgentJWT(
      { agentId, rigId: `mayor-${config.townId}`, townId: config.townId, userId: config.userId },
      secret,
      8 * 3600
    );
  }

  /** System prompt for the mayor agent. */
  private static mayorSystemPrompt(identity: string, townId: string): string {
    return buildMayorSystemPrompt({ identity, townId });
  }

  /**
   * Create a new mayor session in the container.
   * Starts a kilo serve agent and sends the first message.
   */
  private async createSession(
    config: MayorConfig,
    initialMessage: string,
    model?: string
  ): Promise<MayorSession> {
    const agentId = generateId();
    const agentName = `mayor-${Date.now()}`;
    const identity = `mayor-${agentId}`;

    console.log(
      `${MAYOR_LOG} createSession: agentId=${agentId} name=${agentName} townId=${config.townId}`
    );

    const token = await this.mintMayorToken(agentId, config);
    if (!token) {
      console.error(
        `${MAYOR_LOG} createSession: mintMayorToken returned null — GASTOWN_SESSION_TOKEN will be missing from the container env. The gastown plugin will fail to load mayor tools.`
      );
    }

    const envVars: Record<string, string> = {
      // Mayor-specific: tells the plugin to load mayor tools instead of rig tools
      GASTOWN_AGENT_ROLE: 'mayor',
      GASTOWN_TOWN_ID: config.townId,
      GASTOWN_AGENT_ID: agentId,
    };
    if (token) {
      envVars.GASTOWN_SESSION_TOKEN = token;
    }
    if (this.env.GASTOWN_API_URL) {
      envVars.GASTOWN_API_URL = this.env.GASTOWN_API_URL;
    }
    if (this.env.KILO_API_URL) {
      envVars.KILO_API_URL = this.env.KILO_API_URL;
    }
    if (config.kilocodeToken) {
      envVars.KILOCODE_TOKEN = config.kilocodeToken;
    }

    // Tell the container's completion reporter to call back to the MayorDO
    // instead of the Rig DO, so the session is cleared immediately.
    if (this.env.GASTOWN_API_URL) {
      envVars.GASTOWN_COMPLETION_CALLBACK_URL = `${this.env.GASTOWN_API_URL}/api/towns/${config.townId}/mayor/completed`;
    }

    const container = getTownContainerStub(this.env, config.townId);
    const response = await container.fetch('http://container/agents/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        rigId: `mayor-${config.townId}`,
        townId: config.townId,
        role: 'mayor',
        name: agentName,
        identity,
        prompt: initialMessage,
        model,
        systemPrompt: MayorDO.mayorSystemPrompt(identity, config.townId),
        gitUrl: config.gitUrl,
        branch: `gt/mayor`,
        defaultBranch: config.defaultBranch,
        envVars,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      console.error(`${MAYOR_LOG} createSession: container rejected start: ${text.slice(0, 500)}`);
      throw new Error(`Failed to start mayor session in container: ${response.status}`);
    }

    console.log(`${MAYOR_LOG} createSession: container accepted, agentId=${agentId}`);

    return {
      agentId,
      sessionId: agentId, // kilo serve session ID matches agentId from the container
      status: 'starting',
      lastActivityAt: now(),
    };
  }

  /**
   * Send a follow-up message to an existing session via the container.
   */
  private async sendFollowUp(townId: string, agentId: string, message: string): Promise<void> {
    const container = getTownContainerStub(this.env, townId);
    const response = await container.fetch(`http://container/agents/${agentId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: message }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      console.error(
        `${MAYOR_LOG} sendFollowUp: container rejected message for agent ${agentId}: ${text.slice(0, 500)}`
      );
      throw new Error(`Failed to send message to mayor: ${response.status}`);
    }
  }

  /**
   * Best-effort stop of an agent in the container. Errors are logged
   * but do not propagate — used during cleanup paths where we don't
   * want a container failure to block session clearing.
   */
  private async bestEffortStopAgent(townId: string, agentId: string): Promise<void> {
    try {
      const container = getTownContainerStub(this.env, townId);
      await container.fetch(`http://container/agents/${agentId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch (err) {
      console.warn(`${MAYOR_LOG} bestEffortStopAgent: failed to stop agent ${agentId}:`, err);
    }
  }

  /**
   * Check whether an agent session is still running in the container.
   */
  private async isSessionAlive(townId: string, agentId: string): Promise<boolean> {
    try {
      const container = getTownContainerStub(this.env, townId);
      const response = await container.fetch(`http://container/agents/${agentId}/status`);
      if (!response.ok) return false;
      const data = await response.json<{ status: string }>();
      return data.status === 'running' || data.status === 'starting';
    } catch {
      return false;
    }
  }
}

export function getMayorDOStub(env: Env, townId: string) {
  return env.MAYOR.get(env.MAYOR.idFromName(townId));
}
