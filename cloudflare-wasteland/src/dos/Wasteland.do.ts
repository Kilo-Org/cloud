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
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      this.ensureInitialized();
    });
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    query(this.sql, configOps.createTableWastelandConfig(), []);
    query(this.sql, credentialOps.createTableWastelandCredentials(), []);
    query(this.sql, memberOps.createTableWastelandMembers(), []);
    this.initialized = true;
  }

  // ── Config ────────────────────────────────────────────────────────────

  getConfig(): WastelandConfig | null {
    this.ensureInitialized();
    return configOps.getConfig(this.sql);
  }

  initializeWasteland(input: InitWastelandInput): void {
    this.ensureInitialized();
    console.log(`${LOG} initializeWasteland: id=${input.wasteland_id} name=${input.name}`);
    configOps.initializeWasteland(this.sql, input);
  }

  updateConfig(
    update: Partial<Pick<WastelandConfig, 'name' | 'visibility' | 'dolthub_upstream' | 'status'>>
  ): void {
    this.ensureInitialized();
    const config = configOps.getConfig(this.sql);
    if (!config) {
      throw new Error('Cannot update config: wasteland not initialized');
    }
    console.log(`${LOG} updateConfig: id=${config.wasteland_id}`, JSON.stringify(update));
    configOps.updateConfig(this.sql, config.wasteland_id, update);
  }

  // ── Credentials ───────────────────────────────────────────────────────

  storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): void {
    this.ensureInitialized();
    console.log(`${LOG} storeCredential: userId=${userId} org=${dolthubOrg}`);
    credentialOps.storeCredential(this.sql, userId, encryptedToken, dolthubOrg, rigHandle);
  }

  getCredential(userId: string): WastelandCredential | null {
    this.ensureInitialized();
    return credentialOps.getCredential(this.sql, userId);
  }

  deleteCredential(userId: string): void {
    this.ensureInitialized();
    console.log(`${LOG} deleteCredential: userId=${userId}`);
    credentialOps.deleteCredential(this.sql, userId);
  }

  // ── Members ───────────────────────────────────────────────────────────

  addMember(userId: string, role: string, trustLevel: number): string {
    this.ensureInitialized();
    console.log(`${LOG} addMember: userId=${userId} role=${role} trustLevel=${trustLevel}`);
    return memberOps.addMember(this.sql, userId, role, trustLevel);
  }

  removeMember(memberId: string): void {
    this.ensureInitialized();
    console.log(`${LOG} removeMember: memberId=${memberId}`);
    memberOps.removeMember(this.sql, memberId);
  }

  listMembers(): WastelandMember[] {
    this.ensureInitialized();
    return memberOps.listMembers(this.sql);
  }

  getMember(userId: string): WastelandMember | null {
    this.ensureInitialized();
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
