/**
 * WastelandDO — Core Durable Object for wasteland metadata, member
 * credentials, and periodic sync coordination.
 *
 * Much simpler than TownDO: no agents, beads, review queues, or convoys.
 * Manages wasteland configuration, encrypted DoltHub token storage,
 * member registry, and an alarm loop for periodic wanted board sync.
 */

import { DurableObject } from 'cloudflare:workers';

// Sub-modules (plain functions, not classes — per coding conventions)
import * as configOps from './wasteland/config';
import * as credentialOps from './wasteland/credentials';
import * as memberOps from './wasteland/members';

import type { WastelandConfig, InitWastelandInput, WastelandConfigUpdate } from './wasteland/config';
import type { WastelandCredential } from './wasteland/credentials';
import type { WastelandMember } from './wasteland/members';

const WL_LOG = '[Wasteland.do]';

// Alarm interval for periodic wanted board sync
const SYNC_ALARM_INTERVAL_MS = 5 * 60_000; // 5 minutes

export class WastelandDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      this.initializeTables();
      await this.armAlarmIfNeeded();
    });
  }

  private initializeTables(): void {
    configOps.initConfigTables(this.sql);
    credentialOps.initCredentialTables(this.sql);
    memberOps.initMemberTables(this.sql);
  }

  private get wastelandId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  // ══════════════════════════════════════════════════════════════════
  // Configuration
  // ══════════════════════════════════════════════════════════════════

  async getConfig(): Promise<WastelandConfig | null> {
    return configOps.getConfig(this.sql);
  }

  async initializeWasteland(input: InitWastelandInput): Promise<void> {
    const existing = configOps.getConfig(this.sql);
    if (existing) {
      throw new Error(`Wasteland already initialized: ${existing.wasteland_id}`);
    }
    configOps.initializeWasteland(this.sql, input);
    console.log(`${WL_LOG} initialized wasteland ${input.wasteland_id} "${input.name}"`);
  }

  async updateConfig(update: WastelandConfigUpdate): Promise<void> {
    configOps.updateConfig(this.sql, update);
    console.log(`${WL_LOG} updated wasteland config`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Credentials
  // ══════════════════════════════════════════════════════════════════

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string | null
  ): Promise<void> {
    credentialOps.storeCredential(this.sql, userId, encryptedToken, dolthubOrg, rigHandle);
    console.log(`${WL_LOG} stored credential for user ${userId}`);
  }

  async getCredential(userId: string): Promise<WastelandCredential | null> {
    return credentialOps.getCredential(this.sql, userId);
  }

  async deleteCredential(userId: string): Promise<void> {
    credentialOps.deleteCredential(this.sql, userId);
    console.log(`${WL_LOG} deleted credential for user ${userId}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Members
  // ══════════════════════════════════════════════════════════════════

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    const memberId = memberOps.addMember(this.sql, userId, role, trustLevel);
    console.log(`${WL_LOG} added member ${memberId} (user=${userId}, role=${role})`);
    return memberId;
  }

  async removeMember(memberId: string): Promise<void> {
    memberOps.removeMember(this.sql, memberId);
    console.log(`${WL_LOG} removed member ${memberId}`);
  }

  async listMembers(): Promise<WastelandMember[]> {
    return memberOps.listMembers(this.sql);
  }

  // ══════════════════════════════════════════════════════════════════
  // Alarm
  // ══════════════════════════════════════════════════════════════════

  async alarm(): Promise<void> {
    const config = configOps.getConfig(this.sql);
    if (!config || config.status === 'deleted') {
      console.log(`${WL_LOG} alarm: wasteland not active, not re-arming`);
      await this.ctx.storage.deleteAlarm();
      return;
    }

    console.log(`${WL_LOG} alarm: fired for wasteland ${this.wastelandId}`);

    // Placeholder for wanted board polling — will be implemented in Phase 3.
    // The alarm loop will:
    // 1. Fetch the wanted board from DoltHub via the WastelandContainerDO
    // 2. Compare with cached state
    // 3. Emit events for new/changed items

    // Re-arm for next cycle
    await this.armAlarmIfNeeded();
  }

  private async armAlarmIfNeeded(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SYNC_ALARM_INTERVAL_MS);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════

  async destroy(): Promise<void> {
    console.log(`${WL_LOG} destroying wasteland ${this.wastelandId}`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
