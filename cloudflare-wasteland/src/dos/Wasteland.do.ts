import { DurableObject } from 'cloudflare:workers';
import { query } from '../util/query.util';
import * as configOps from './wasteland/config';
import * as credentialOps from './wasteland/credentials';
import * as memberOps from './wasteland/members';

const LOG = '[Wasteland.do]';

export type WastelandConfig = configOps.WastelandConfigRecord;
export type InitWastelandInput = configOps.InitWastelandInput;
export type WastelandCredential = credentialOps.WastelandCredentialRecord;
export type WastelandMember = memberOps.WastelandMemberRecord;

/**
 * WastelandDO — per-wasteland Durable Object storing configuration,
 * encrypted credentials, and member registry in SQLite.
 *
 * Keying: one DO instance per wasteland (keyed by `wasteland_id`).
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

  // ── Alarm ─────────────────────────────────────────────────────────────
  // Placeholder for wanted board polling (Phase 2 task 6)

  async alarm(): Promise<void> {
    console.log(`${LOG} alarm: placeholder — wanted board polling not yet implemented`);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
