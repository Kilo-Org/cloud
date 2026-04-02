/**
 * WastelandDO — per-wasteland Durable Object.
 *
 * Manages config, members, credentials, connected towns, and wanted board cache.
 * The alarm loop periodically polls DoltHub for wanted board state and caches
 * results in local SQLite for fast reads.
 */
import { DurableObject } from 'cloudflare:workers';
import * as configOps from './wasteland/config';
import * as memberOps from './wasteland/members';
import * as credentialOps from './wasteland/credentials';
import * as connectedTownOps from './wasteland/connected-towns';
import * as wantedCacheOps from './wasteland/wanted-cache';
import { fetchWantedBoard } from '../util/dolthub-api.util';
import type { WastelandConfigRecord } from '../db/tables/wasteland-config.table';
import type { WastelandMemberRecord } from '../db/tables/wasteland-members.table';
import type { WastelandCredentialRecord } from '../db/tables/wasteland-credentials.table';
import type { ConnectedTownRecord } from '../db/tables/wasteland-connected-towns.table';
import type { WantedCacheRecord } from '../db/tables/wasteland-wanted-cache.table';
import type {
  InitializeWastelandInput,
  UpdateWastelandConfigInput,
} from './WastelandDO.stub';

const LOG = '[WastelandDO]';

/** Polling interval for the alarm loop: 5 minutes. */
const ALARM_INTERVAL_MS = 5 * 60 * 1000;

export class WastelandDO extends DurableObject<Env> {
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
    configOps.initConfigTable(this.sql);
    memberOps.initMembersTable(this.sql);
    credentialOps.initCredentialsTable(this.sql);
    connectedTownOps.initConnectedTownsTable(this.sql);
    wantedCacheOps.initWantedCacheTable(this.sql);

    // Ensure the alarm is running if this wasteland is active
    await this.armAlarmIfNeeded();
  }

  // ── Alarm ───────────────────────────────────────────────────────────

  /**
   * Arm the alarm loop if the wasteland is configured and active.
   * Called after DB init and after config changes that enable polling.
   */
  private async armAlarmIfNeeded(): Promise<void> {
    const config = configOps.getConfig(this.sql);
    if (!config || config.status !== 'active' || !config.dolthub_upstream) {
      return;
    }

    const current = await this.ctx.storage.getAlarm();
    if (!current || current < Date.now()) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async alarm(): Promise<void> {
    const config = configOps.getConfig(this.sql);
    if (!config || config.status !== 'active' || !config.dolthub_upstream) {
      return; // No polling for inactive or unconfigured wastelands
    }

    try {
      const items = await fetchWantedBoard(config.dolthub_upstream);
      wantedCacheOps.cacheWantedItems(this.sql, items);
    } catch (err) {
      console.error(`${LOG} alarm polling failed`, err);
    }

    // Re-arm: poll again in 5 minutes
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ── Config RPCs ─────────────────────────────────────────────────────

  async initializeWasteland(input: InitializeWastelandInput): Promise<WastelandConfigRecord> {
    await this.ensureInitialized();
    const config = configOps.insertConfig(this.sql, input);

    // Schedule the first alarm 1s after creation if upstream is configured
    if (input.dolthub_upstream) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }

    return config;
  }

  async getConfig(): Promise<WastelandConfigRecord | null> {
    await this.ensureInitialized();
    return configOps.getConfig(this.sql);
  }

  async updateConfig(input: UpdateWastelandConfigInput): Promise<WastelandConfigRecord> {
    await this.ensureInitialized();
    const config = configOps.updateConfig(this.sql, input);

    // If dolthub_upstream was just set, ensure alarm is running
    if (input.dolthub_upstream !== undefined) {
      await this.armAlarmIfNeeded();
    }

    return config;
  }

  // ── Member RPCs ─────────────────────────────────────────────────────

  async listMembers(): Promise<WastelandMemberRecord[]> {
    await this.ensureInitialized();
    return memberOps.listMembers(this.sql);
  }

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    await this.ensureInitialized();
    return memberOps.addMember(this.sql, userId, role, trustLevel);
  }

  async removeMember(memberId: string): Promise<void> {
    await this.ensureInitialized();
    memberOps.removeMember(this.sql, memberId);
  }

  async getMember(userId: string): Promise<WastelandMemberRecord | null> {
    await this.ensureInitialized();
    return memberOps.getMember(this.sql, userId);
  }

  async updateMember(
    memberId: string,
    update: { role?: string; trust_level?: number }
  ): Promise<WastelandMemberRecord | null> {
    await this.ensureInitialized();
    return memberOps.updateMember(this.sql, memberId, update);
  }

  // ── Credential RPCs ────────────────────────────────────────────────

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<WastelandCredentialRecord> {
    await this.ensureInitialized();
    return credentialOps.storeCredential(this.sql, userId, encryptedToken, dolthubOrg, rigHandle);
  }

  async getCredential(userId: string): Promise<WastelandCredentialRecord | null> {
    await this.ensureInitialized();
    return credentialOps.getCredential(this.sql, userId);
  }

  async deleteCredential(userId: string): Promise<void> {
    await this.ensureInitialized();
    credentialOps.deleteCredential(this.sql, userId);
  }

  // ── Connected Towns RPCs ────────────────────────────────────────────

  async connectTown(townId: string, userId: string): Promise<ConnectedTownRecord> {
    await this.ensureInitialized();
    const config = configOps.getConfig(this.sql);
    const wastelandId = config?.wasteland_id ?? '';
    return connectedTownOps.connectTown(this.sql, townId, wastelandId, userId);
  }

  async disconnectTown(townId: string): Promise<void> {
    await this.ensureInitialized();
    connectedTownOps.disconnectTown(this.sql, townId);
  }

  async listConnectedTowns(): Promise<ConnectedTownRecord[]> {
    await this.ensureInitialized();
    return connectedTownOps.listConnectedTowns(this.sql);
  }

  // ── Wanted Board RPCs ──────────────────────────────────────────────

  async getWantedBoard(): Promise<WantedCacheRecord[]> {
    await this.ensureInitialized();
    return wantedCacheOps.getCachedWantedItems(this.sql);
  }

  async refreshWantedBoard(): Promise<WantedCacheRecord[]> {
    await this.ensureInitialized();
    const config = configOps.getConfig(this.sql);
    if (!config?.dolthub_upstream) {
      return wantedCacheOps.getCachedWantedItems(this.sql);
    }

    const items = await fetchWantedBoard(config.dolthub_upstream);
    wantedCacheOps.cacheWantedItems(this.sql, items);
    return wantedCacheOps.getCachedWantedItems(this.sql);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
