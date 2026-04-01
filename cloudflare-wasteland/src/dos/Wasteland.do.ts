import { DurableObject } from 'cloudflare:workers';
import { query } from '../util/query.util';
import { fetchWantedBoard } from '../util/dolthub-api.util';
import * as configOps from './wasteland/config';
import * as credentialOps from './wasteland/credentials';
import * as memberOps from './wasteland/members';
import * as wantedCacheOps from './wasteland/wanted-cache';

const LOG = '[Wasteland.do]';

/** Alarm fires every 5 minutes for active wastelands. */
const ALARM_INTERVAL_MS = 5 * 60 * 1_000;

export type WastelandConfig = configOps.WastelandConfigRecord;
export type InitWastelandInput = configOps.InitWastelandInput;
export type WastelandCredential = credentialOps.WastelandCredentialRecord;
export type WastelandMember = memberOps.WastelandMemberRecord;
export type WantedItem = wantedCacheOps.WantedItem;
export type WantedItemRecord = wantedCacheOps.WantedItemRecord;

/**
 * WastelandDO — per-wasteland Durable Object storing configuration,
 * encrypted credentials, member registry, and wanted board cache in SQLite.
 *
 * Keying: one DO instance per wasteland (keyed by `wasteland_id`).
 *
 * The alarm loop periodically polls DoltHub for wanted board state
 * and caches it locally for fast reads without waking a Container.
 */
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
    query(this.sql, configOps.createTableWastelandConfig(), []);
    query(this.sql, credentialOps.createTableWastelandCredentials(), []);
    query(this.sql, memberOps.createTableWastelandMembers(), []);
    query(this.sql, wantedCacheOps.createTableWastelandWantedCache(), []);
    await Promise.resolve();
  }

  // ── Config ────────────────────────────────────────────────────────────

  async getConfig(): Promise<WastelandConfig | null> {
    await this.ensureInitialized();
    return configOps.getConfig(this.sql);
  }

  async initializeWasteland(input: InitWastelandInput): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} initializeWasteland: id=${input.wasteland_id} name=${input.name}`);
    configOps.initializeWasteland(this.sql, input);

    // Start the alarm loop shortly after creation so the first poll fires quickly.
    void this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  async updateConfig(
    update: Partial<Pick<WastelandConfig, 'name' | 'visibility' | 'dolthub_upstream' | 'status'>>
  ): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} updateConfig:`, JSON.stringify(update));
    configOps.updateConfig(this.sql, update);
  }

  // ── Credentials ───────────────────────────────────────────────────────

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} storeCredential: userId=${userId} org=${dolthubOrg}`);
    credentialOps.storeCredential(this.sql, userId, encryptedToken, dolthubOrg, rigHandle);
  }

  async getCredential(userId: string): Promise<WastelandCredential | null> {
    await this.ensureInitialized();
    return credentialOps.getCredential(this.sql, userId);
  }

  async deleteCredential(userId: string): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} deleteCredential: userId=${userId}`);
    credentialOps.deleteCredential(this.sql, userId);
  }

  // ── Members ───────────────────────────────────────────────────────────

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    await this.ensureInitialized();
    console.log(`${LOG} addMember: userId=${userId} role=${role} trustLevel=${trustLevel}`);
    return memberOps.addMember(this.sql, userId, role, trustLevel);
  }

  async removeMember(memberId: string): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} removeMember: memberId=${memberId}`);
    memberOps.removeMember(this.sql, memberId);
  }

  async listMembers(): Promise<WastelandMember[]> {
    await this.ensureInitialized();
    return memberOps.listMembers(this.sql);
  }

  async getMember(userId: string): Promise<WastelandMember | null> {
    await this.ensureInitialized();
    return memberOps.getMember(this.sql, userId);
  }

  // ── Wanted Board (cached reads) ───────────────────────────────────────

  /** Return all cached wanted items. */
  async browseWanted(): Promise<WantedItemRecord[]> {
    await this.ensureInitialized();
    return wantedCacheOps.getCachedWantedItems(this.sql);
  }

  /** Return a single cached wanted item by ID. */
  async getWantedItem(itemId: string): Promise<WantedItemRecord | null> {
    await this.ensureInitialized();
    return wantedCacheOps.getCachedWantedItem(this.sql, itemId);
  }

  /** Force-refresh the cache from DoltHub and return the new items. */
  async refreshWanted(): Promise<WantedItemRecord[]> {
    await this.ensureInitialized();
    const config = configOps.getConfig(this.sql);
    if (!config?.dolthub_upstream) {
      return [];
    }

    const items = await fetchWantedBoard(config.dolthub_upstream);
    wantedCacheOps.cacheWantedItems(this.sql, items);
    return wantedCacheOps.getCachedWantedItems(this.sql);
  }

  // ── Alarm ─────────────────────────────────────────────────────────────

  /**
   * Periodically polls DoltHub for wanted board state and caches results
   * in SQLite for fast reads. Re-arms the alarm for the next tick.
   */
  async alarm(): Promise<void> {
    await this.ensureInitialized();
    const config = configOps.getConfig(this.sql);
    if (!config || config.status !== 'active' || !config.dolthub_upstream) {
      // No polling for inactive or unconfigured wastelands.
      return;
    }

    try {
      const items = await fetchWantedBoard(config.dolthub_upstream);
      wantedCacheOps.cacheWantedItems(this.sql, items);
    } catch (err) {
      console.error(`${LOG} alarm polling failed`, err);
    }

    // Schedule next alarm tick.
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
