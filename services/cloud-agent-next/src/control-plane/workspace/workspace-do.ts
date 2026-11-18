import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import {
  RuntimeAuthorizationExpiredError,
  RuntimeAuthorizationRevokedError,
  renewRuntimeAuthorization,
  sealRuntimeAuthorization,
  unsealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import { resolveSecret } from '../../auth.js';
import {
  CLOUD_AGENT_PARENT_AUTHORITY_DENIED,
  WorkspaceAuthorityRecordSchema,
  assertWorkspaceAuthority,
  deriveWorkspaceRuntimeAuthorization,
  matchesWorkspaceMcpBinding,
  signWorkspaceMcpGrant,
  workspaceAuthorityFromAnchor,
  workspaceAuthorityUnavailableReason,
  workspaceSessionIdSchema,
  type WorkspaceAuthorityRecord,
  type WorkspaceAuthoritySeed,
  type WorkspaceChildEntry,
  type WorkspaceEgress,
  type WorkspaceMcpBinding,
} from '../../cloud-agent-authority.js';
import { logger } from '../../logger.js';
import { getSandboxSessionStub, type SessionStub } from '../../sandbox-session/session-stub.js';
import { logRuntimeAuthorizationDiagnostic } from '../../session/runtime-authorization-diagnostics.js';
import { sessionIdFromDoName } from '../../session-identity.js';
import type { Env } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';

const RECORD_KEY = 'authority';
const DELETED_KEY = 'deleted';
const UNADOPTABLE_UNTIL_KEY = 'unadoptable_until';
// A workspace whose creating chat cannot launch children is asked again only after this.
const UNADOPTABLE_RECHECK_MS = 10 * 60_000;
const CHILD_PREFIX = 'child:';

const childSessionIdSchema = workspaceSessionIdSchema;
const childEntrySchema = z
  .object({
    initialMessageId: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
const childRegistrationSchema = z
  .object({
    cloudAgentSessionId: childSessionIdSchema,
    initialMessageId: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
  })
  .strict();
const childListSchema = z
  .object({
    limit: z.number().int().min(1).max(50),
    cursor: z.uuid().optional(),
  })
  .strict();

export type WorkspaceChildPage = { sessions: WorkspaceChildEntry[]; nextCursor?: string };

/** `authorizationId` is null exactly when the workspace is unestablished or deleted. */
export type WorkspaceAuthorityDescription = {
  state: 'unestablished' | 'deleted' | 'active' | 'expired' | 'revoked';
  authorizationId: string | null;
  worktreeId: string | null;
  organizationId: string | null;
};

type LiveAuthority = { record: WorkspaceAuthorityRecord; token: string };

function denied(): Error {
  return new Error(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
}

function isDenied(error: unknown): boolean {
  return error instanceof Error && error.message.includes(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
}

/**
 * The durable owner of one workspace's Cloud Agent authority, keyed by
 * `ownerId:workspace_<uuid>`. It owns the workspace's runtime delegation and
 * revocation state, direct-child discovery hints, and the issuance of the
 * workspace MCP credential. No chat's authorization or lifecycle grants or
 * revokes this authority after the one-time adoption from the creating chat.
 */
export class CloudAgentWorkspaceDO extends DurableObject<Env> {
  private readonly ownerId: string | null;
  private readonly workspaceSessionId: string | null;
  private adopting: Promise<WorkspaceAuthorityRecord | undefined> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const name = ctx.id.name ?? '';
    const workspaceSessionId = workspaceSessionIdSchema.safeParse(sessionIdFromDoName(name));
    const ownerId = name.slice(0, Math.max(0, name.lastIndexOf(':')));
    this.workspaceSessionId = workspaceSessionId.success ? workspaceSessionId.data : null;
    this.ownerId = workspaceSessionId.success && ownerId.length > 0 ? ownerId : null;
  }

  /** Issues the workspace MCP credential, or nothing when the workspace cannot launch. */
  async issueMcpGrant(
    binding: WorkspaceMcpBinding
  ): Promise<{ url: string; token: string; expiresAt: number } | undefined> {
    const record = await this.record();
    if (record === undefined) return undefined;
    if (!matchesWorkspaceMcpBinding(record, binding)) {
      this.diagnostic('mcp_grant', 'workspace_mismatch');
      return undefined;
    }
    const unavailable = workspaceAuthorityUnavailableReason(record, Date.now());
    if (unavailable !== undefined) {
      this.diagnostic('mcp_grant', unavailable);
      return undefined;
    }
    let live: LiveAuthority;
    try {
      live = await this.renewLive(record);
    } catch (error) {
      if (isDenied(error)) return undefined;
      throw error;
    }
    const secret = await this.secret();
    const verified = await verifyKiloTokenForPolicy(live.token, secret, {
      audience: 'kilo-api',
      mode: 'required',
    });
    return signWorkspaceMcpGrant({
      record: live.record,
      pepper: verified.claims.apiTokenPepper ?? null,
      secret,
      mcpUrl: this.env.CLOUD_AGENT_MCP_URL_OVERRIDE,
      now: Date.now(),
    });
  }

  /** Checks a presented authority against the stored grant and the live owner and organization. */
  async assertAuthority(authority: unknown): Promise<void> {
    await this.liveAuthority(authority);
  }

  /** Authority check for a launch, plus the workspace policy the child inherits. */
  async getSpawnContext(authority: unknown): Promise<{
    token: string;
    createdOnPlatform: string | undefined;
    egress: WorkspaceEgress | undefined;
  }> {
    const live = await this.liveAuthority(authority);
    return {
      token: live.token,
      createdOnPlatform: live.record.createdOnPlatform,
      egress: live.record.egress,
    };
  }

  /** Delegates the workspace authority to one new direct child. */
  async authorizeChild(input: {
    authority: CloudAgentAuthority;
    childSessionId: string;
  }): Promise<{ token: string; seal: string }> {
    const record = await this.record();
    assertWorkspaceAuthority(record, input.authority);
    return this.delegate(record, input.childSessionId, input.authority);
  }

  /** Delegates the workspace authority to a new chat in this workspace (a callback chat). */
  async authorizeChat(input: { chatSessionId: string }): Promise<{
    token: string;
    seal: string;
    worktreeId: string | null;
    organizationId: string | null;
  }> {
    const record = await this.record();
    if (record === undefined || workspaceAuthorityUnavailableReason(record, Date.now())) {
      throw denied();
    }
    const delegated = await this.delegate(record, input.chatSessionId);
    return { ...delegated, worktreeId: record.worktreeId, organizationId: record.organizationId };
  }

  async describe(): Promise<WorkspaceAuthorityDescription> {
    const absent = { authorizationId: null, worktreeId: null, organizationId: null };
    if (await this.isDeleted()) return { state: 'deleted', ...absent };
    const record = await this.record();
    if (record === undefined) return { state: 'unestablished', ...absent };
    const unavailable = workspaceAuthorityUnavailableReason(record, Date.now());
    return {
      state:
        unavailable === 'stored_authorization_revoked'
          ? 'revoked'
          : unavailable === 'delegation_expired'
            ? 'expired'
            : 'active',
      authorizationId: record.authorization.id,
      worktreeId: record.worktreeId,
      organizationId: record.organizationId,
    };
  }

  /**
   * Restores an expired workspace authority from a delegation the owner just
   * admitted with a user credential. A revoked or deleted workspace, a changed
   * authorization, or a delegation for another owner, organization or
   * workspace is refused, so neither a sibling chat, a sandbox restart nor a
   * stale token can restore authority the workspace lost.
   */
  async reauthorize(input: {
    expectedAuthorizationId: string;
    runtimeAuthorizationSeal: string;
  }): Promise<{ status: 'renewed' | 'not-needed' | 'denied' | 'retry' }> {
    const record = await this.readRecord();
    if (record === undefined || (await this.isDeleted())) return { status: 'denied' };
    let fresh: RuntimeAuthorization;
    try {
      fresh = await unsealRuntimeAuthorization(
        input.runtimeAuthorizationSeal,
        await this.secret(),
        {
          resourceKind: 'cloud-agent-next',
          resourceId: record.workspaceSessionId,
          userId: record.ownerId,
          organizationId: record.organizationId ?? undefined,
        }
      );
    } catch {
      return { status: 'denied' };
    }
    const now = Date.now();
    if (fresh.state !== 'active' || Date.parse(fresh.delegationExpiresAt) <= now) {
      return { status: 'denied' };
    }
    const current = await this.readRecord();
    if (current === undefined || (await this.isDeleted())) return { status: 'denied' };
    const unavailable = workspaceAuthorityUnavailableReason(current, now);
    if (unavailable === 'stored_authorization_revoked') return { status: 'denied' };
    if (unavailable === undefined) return { status: 'not-needed' };
    if (current.authorization.id !== input.expectedAuthorizationId) return { status: 'retry' };
    const next = WorkspaceAuthorityRecordSchema.parse({ ...current, authorization: fresh });
    await this.ctx.storage.put(RECORD_KEY, next);
    logger
      .withFields({ workspaceSessionId: current.workspaceSessionId })
      .info('Workspace Cloud Agent authority renewed');
    return { status: 'renewed' };
  }

  async recordChild(input: unknown): Promise<{ success: true }> {
    const child = childRegistrationSchema.parse(input);
    const record = await this.record();
    if (record === undefined) throw new Error('Cloud Agent child registry denied');
    if (child.cloudAgentSessionId === record.workspaceSessionId) {
      throw new Error('Cloud Agent child registry requires another session');
    }
    const key = `${CHILD_PREFIX}${child.cloudAgentSessionId}`;
    if ((await this.ctx.storage.get(key)) === undefined) {
      await this.ctx.storage.put(
        key,
        childEntrySchema.parse({
          ...(child.initialMessageId === undefined
            ? {}
            : { initialMessageId: child.initialMessageId }),
          ...(child.worktreeId === undefined ? {} : { worktreeId: child.worktreeId }),
          createdAt: Date.now(),
        })
      );
    }
    return { success: true };
  }

  async forgetChild(input: unknown): Promise<{ success: true }> {
    const childSessionId = childSessionIdSchema.parse(input);
    await this.ctx.storage.delete(`${CHILD_PREFIX}${childSessionId}`);
    return { success: true };
  }

  async listChildren(input: unknown): Promise<WorkspaceChildPage> {
    const page = childListSchema.parse(input);
    await this.record();
    const entries = await this.ctx.storage.list<unknown>({
      prefix: CHILD_PREFIX,
      ...(page.cursor === undefined
        ? {}
        : { startAfter: `${CHILD_PREFIX}workspace_${page.cursor}` }),
      limit: page.limit + 1,
    });
    const sessions: WorkspaceChildEntry[] = [];
    for (const [key, value] of entries) {
      const entry = childEntrySchema.safeParse(value);
      if (!entry.success) continue;
      sessions.push({
        cloudAgentSessionId: key.slice(CHILD_PREFIX.length),
        ...(entry.data.initialMessageId === undefined
          ? {}
          : { initialMessageId: entry.data.initialMessageId }),
        ...(entry.data.worktreeId === undefined ? {} : { worktreeId: entry.data.worktreeId }),
      });
    }
    const visible = sessions.slice(0, page.limit);
    const last = visible.at(-1);
    return {
      sessions: visible,
      ...(entries.size > page.limit && last !== undefined
        ? { nextCursor: last.cloudAgentSessionId.slice('workspace_'.length) }
        : {}),
    };
  }

  /**
   * Permanently ends this workspace's authority. The tombstone is written
   * first, so a crash in between leaves a denied workspace rather than one that
   * could be adopted again.
   */
  async markDeleted(): Promise<void> {
    await this.ctx.storage.put(DELETED_KEY, { deletedAt: Date.now() });
    const keys = [
      ...(await this.ctx.storage.list({ prefix: CHILD_PREFIX })).keys(),
      RECORD_KEY,
      UNADOPTABLE_UNTIL_KEY,
    ];
    for (let index = 0; index < keys.length; index += 128) {
      await this.ctx.storage.delete(keys.slice(index, index + 128));
    }
  }

  private async liveAuthority(authority: unknown): Promise<LiveAuthority> {
    const record = await this.record();
    assertWorkspaceAuthority(record, authority);
    const live = await this.renewLive(record);
    assertWorkspaceAuthority(live.record, authority);
    return live;
  }

  /**
   * Renews the stored delegation, which rechecks the owner, organization
   * membership, credential pepper and admitting device session in the
   * database. A failed binding persists the revocation. The record must be
   * unchanged after the check.
   */
  private async renewLive(record: WorkspaceAuthorityRecord): Promise<LiveAuthority> {
    const secret = await this.secret();
    let token: string;
    try {
      ({ token } = await renewRuntimeAuthorization({
        authorization: record.authorization,
        secret,
        connectionString: this.env.HYPERDRIVE.connectionString,
        onBindingRejected: reason => this.diagnostic('binding_check', reason),
      }));
    } catch (error) {
      if (error instanceof RuntimeAuthorizationRevokedError) {
        await this.revokeIfCurrent(record.authorization.id);
        throw denied();
      }
      if (error instanceof RuntimeAuthorizationExpiredError) throw denied();
      throw error;
    }
    return { record: await this.requireUnchanged(record), token };
  }

  private async delegate(
    record: WorkspaceAuthorityRecord,
    resourceId: string,
    authority?: CloudAgentAuthority
  ): Promise<{ token: string; seal: string }> {
    const now = Date.now();
    const delegated = deriveWorkspaceRuntimeAuthorization(record, resourceId, now);
    const secret = await this.secret();
    let token: string;
    try {
      ({ token } = await renewRuntimeAuthorization({
        authorization: delegated,
        secret,
        connectionString: this.env.HYPERDRIVE.connectionString,
        onBindingRejected: reason => this.diagnostic('binding_check', reason),
      }));
    } catch (error) {
      if (error instanceof RuntimeAuthorizationRevokedError) {
        await this.revokeIfCurrent(record.authorization.id);
        throw denied();
      }
      if (error instanceof RuntimeAuthorizationExpiredError) throw denied();
      throw error;
    }
    const current = await this.requireUnchanged(record);
    if (authority !== undefined) assertWorkspaceAuthority(current, authority);
    return { token, seal: await sealRuntimeAuthorization(delegated, secret) };
  }

  private async requireUnchanged(
    record: WorkspaceAuthorityRecord
  ): Promise<WorkspaceAuthorityRecord> {
    const current = await this.readRecord();
    if (
      current === undefined ||
      (await this.isDeleted()) ||
      current.authorization.id !== record.authorization.id ||
      workspaceAuthorityUnavailableReason(current, Date.now()) !== undefined
    ) {
      throw denied();
    }
    return current;
  }

  private async revokeIfCurrent(authorizationId: string): Promise<void> {
    const current = await this.readRecord();
    if (current?.authorization.id !== authorizationId || current.authorization.state !== 'active') {
      return;
    }
    await this.ctx.storage.put(
      RECORD_KEY,
      WorkspaceAuthorityRecordSchema.parse({
        ...current,
        authorization: { ...current.authorization, state: 'revoked' },
      })
    );
    this.diagnostic('workspace_authority', 'revocation_persisted');
  }

  /** The stored record, adopting it once from the chat that created the workspace. */
  private async record(): Promise<WorkspaceAuthorityRecord | undefined> {
    if (await this.isDeleted()) return undefined;
    const stored = await this.readRecord();
    if (stored !== undefined) return stored;
    const unadoptableUntil = await this.ctx.storage.get<number>(UNADOPTABLE_UNTIL_KEY);
    if (typeof unadoptableUntil === 'number' && unadoptableUntil > Date.now()) return undefined;
    this.adopting ??= this.adoptFromAnchor().finally(() => {
      this.adopting = null;
    });
    return this.adopting;
  }

  /**
   * Adopts the creating chat's authorization and child registry. Runs only for
   * a workspace without a record; the anchor is the canonical workspace chat,
   * never a sibling.
   */
  private async adoptFromAnchor(): Promise<WorkspaceAuthorityRecord | undefined> {
    if (this.ownerId === null || this.workspaceSessionId === null) return undefined;
    const ownerId = this.ownerId;
    const workspaceSessionId = this.workspaceSessionId;
    const seed = await withDORetry<SessionStub, WorkspaceAuthoritySeed | null>(
      () => getSandboxSessionStub(this.env, ownerId, workspaceSessionId),
      stub => stub.exportWorkspaceAuthoritySeed(),
      'exportWorkspaceAuthoritySeed'
    );
    const record = seed === null ? undefined : workspaceAuthorityFromAnchor(seed, Date.now());
    if (
      seed === null ||
      record === undefined ||
      record.workspaceSessionId !== workspaceSessionId ||
      record.ownerId !== ownerId
    ) {
      this.diagnostic('workspace_authority', 'workspace_unestablished');
      await this.ctx.storage.put(UNADOPTABLE_UNTIL_KEY, Date.now() + UNADOPTABLE_RECHECK_MS);
      return undefined;
    }
    if (await this.isDeleted()) return undefined;
    const existing = await this.readRecord();
    if (existing !== undefined) return existing;
    const entries: Record<string, unknown> = {};
    for (const child of seed.children) {
      const parsed = childRegistrationSchema.safeParse(child);
      if (!parsed.success || parsed.data.cloudAgentSessionId === workspaceSessionId) continue;
      entries[`${CHILD_PREFIX}${parsed.data.cloudAgentSessionId}`] = childEntrySchema.parse({
        ...(parsed.data.initialMessageId === undefined
          ? {}
          : { initialMessageId: parsed.data.initialMessageId }),
        ...(parsed.data.worktreeId === undefined ? {} : { worktreeId: parsed.data.worktreeId }),
        createdAt: record.establishedAt,
      });
    }
    const keys = Object.keys(entries);
    for (let index = 0; index < keys.length; index += 127) {
      const batch = Object.fromEntries(
        keys.slice(index, index + 127).map(key => [key, entries[key]])
      );
      await this.ctx.storage.put(batch);
    }
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.ctx.storage.delete(UNADOPTABLE_UNTIL_KEY);
    logger
      .withFields({ workspaceSessionId, children: keys.length })
      .info('Workspace Cloud Agent authority adopted from its creating chat');
    return record;
  }

  private async readRecord(): Promise<WorkspaceAuthorityRecord | undefined> {
    const parsed = WorkspaceAuthorityRecordSchema.safeParse(await this.ctx.storage.get(RECORD_KEY));
    if (
      !parsed.success ||
      parsed.data.ownerId !== this.ownerId ||
      parsed.data.workspaceSessionId !== this.workspaceSessionId
    ) {
      return undefined;
    }
    return parsed.data;
  }

  private async isDeleted(): Promise<boolean> {
    return (await this.ctx.storage.get(DELETED_KEY)) !== undefined;
  }

  private async secret(): Promise<string> {
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) throw new Error('Authentication unavailable');
    return secret;
  }

  private diagnostic(
    stage: Parameters<typeof logRuntimeAuthorizationDiagnostic>[1],
    reason: Parameters<typeof logRuntimeAuthorizationDiagnostic>[2]
  ): void {
    logRuntimeAuthorizationDiagnostic(this.workspaceSessionId ?? undefined, stage, reason);
  }
}
