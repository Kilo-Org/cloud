import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  addUserToOrganization,
  getOrganizationById,
} from '@kilocode/web-shared/lib/organizations/organizations';
import {
  organization_audit_logs,
  organization_permission_events_daily,
  organization_permission_rules,
  type NewOrganizationPermissionEventDaily,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { desc, eq, inArray } from 'drizzle-orm';
import { MAX_ORGANIZATION_PERMISSION_RULES } from '@/lib/organizations/permissions/types';

let owner: User;
let member: User;
let organizationId: string;
let otherOrganizationId: string;
let plainOrganizationId: string;

function today(offsetDays = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - offsetDays);
  return date.toISOString().slice(0, 10);
}

async function latestAuditLog(orgId = organizationId) {
  const [auditLog] = await db
    .select()
    .from(organization_audit_logs)
    .where(eq(organization_audit_logs.organization_id, orgId))
    .orderBy(desc(organization_audit_logs.created_at))
    .limit(1);
  return auditLog;
}

async function insertEvent(overrides: Partial<NewOrganizationPermissionEventDaily> = {}) {
  const now = new Date().toISOString();
  await db.insert(organization_permission_events_daily).values({
    organization_id: organizationId,
    day: today(),
    kilo_user_id: member.id,
    client: 'cli',
    permission: 'bash',
    command_key: 'git push',
    decision: 'denied',
    count: 1,
    first_seen_at: now,
    last_seen_at: now,
    ...overrides,
  });
}

describe('organization permission rules router', () => {
  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'owner-permissions@example.com',
      google_user_name: 'Owner Permissions',
      is_admin: false,
    });
    member = await insertTestUser({
      google_user_email: 'member-permissions@example.com',
      google_user_name: 'Member Permissions',
      is_admin: false,
    });
    organizationId = (
      await createTestOrganization('Permissions Org', owner.id, 0, { kilo_encrypt: true }, false)
    ).id;
    await addUserToOrganization(organizationId, member.id, 'member');
    otherOrganizationId = (
      await createTestOrganization(
        'Other Permissions Org',
        owner.id,
        0,
        { kilo_encrypt: true },
        false
      )
    ).id;
    plainOrganizationId = (
      await createTestOrganization('Plain Permissions Org', owner.id, 0, {}, false)
    ).id;
  });

  beforeEach(async () => {
    const orgIds = [organizationId, otherOrganizationId];
    await db
      .delete(organization_permission_events_daily)
      .where(inArray(organization_permission_events_daily.organization_id, orgIds));
    await db
      .delete(organization_permission_rules)
      .where(inArray(organization_permission_rules.organization_id, orgIds));
  });

  describe('access', () => {
    it('rejects members', async () => {
      const caller = await createCallerForUser(member.id);
      await expect(caller.organizations.permissionRules.list({ organizationId })).rejects.toThrow();
      await expect(
        caller.organizations.permissionRules.add({
          organizationId,
          tier: 'final_deny',
          permission: 'bash',
          pattern: 'rm *',
        })
      ).rejects.toThrow();
    });

    it('rejects organizations without AI Guardrails access', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.permissionRules.list({ organizationId: plainOrganizationId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.organizations.permissionRules.add({
          organizationId: plainOrganizationId,
          tier: 'final_deny',
          permission: 'bash',
          pattern: 'rm *',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('enforcement', () => {
    it('defaults to off and allow', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(caller.organizations.permissionRules.list({ organizationId })).resolves.toEqual({
        enforcement: 'off',
        defaultEffect: 'allow',
        rules: [],
      });
    });

    it('persists enforcement and default independently and audits them', async () => {
      const caller = await createCallerForUser(owner.id);
      await caller.organizations.permissionRules.setEnforcement({
        organizationId,
        enforcement: 'shadow',
      });
      await expect(
        caller.organizations.permissionRules.setEnforcement({
          organizationId,
          defaultEffect: 'ask',
        })
      ).resolves.toEqual({ enforcement: 'shadow', defaultEffect: 'ask' });

      const organization = await getOrganizationById(organizationId);
      expect(organization?.settings).toEqual(
        expect.objectContaining({
          kilo_encrypt: true,
          guardrails: expect.objectContaining({
            permissions: { enforcement: 'shadow', default_effect: 'ask' },
          }),
        })
      );
      const auditLog = await latestAuditLog();
      expect(auditLog.action).toBe('organization.settings.change');
      expect(auditLog.message).toBe('Set permission enforcement to shadow, default ask');

      await caller.organizations.permissionRules.setEnforcement({
        organizationId,
        enforcement: 'off',
        defaultEffect: 'allow',
      });
    });

    it('requires a change', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.permissionRules.setEnforcement({ organizationId })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('rules', () => {
    it('adds, lists in tier order, updates, and deletes with audit logs', async () => {
      const caller = await createCallerForUser(owner.id);
      const deny = await caller.organizations.permissionRules.add({
        organizationId,
        tier: 'final_deny',
        permission: 'bash',
        pattern: 'git push *',
        description: 'No pushes',
      });
      expect(deny.rule).toMatchObject({
        tier: 'final_deny',
        action: 'deny',
        scope: { type: 'organization' },
        source: { type: 'admin_ui' },
        description: 'No pushes',
      });
      expect(deny.warnings).toEqual([]);
      let auditLog = await latestAuditLog();
      expect(auditLog.action).toBe('organization.permission_rule.add');
      expect(auditLog.message).toBe('Added final_deny permission rule bash "git push *"');

      await caller.organizations.permissionRules.add({
        organizationId,
        tier: 'broad_allow',
        permission: 'bash',
        pattern: 'git *',
      });
      const listed = await caller.organizations.permissionRules.list({ organizationId });
      expect(listed.rules.map(rule => rule.tier)).toEqual(['broad_allow', 'final_deny']);

      const updated = await caller.organizations.permissionRules.update({
        organizationId,
        ruleId: deny.rule.id,
        tier: 'specific_deny',
        description: null,
      });
      expect(updated.rule).toMatchObject({ tier: 'specific_deny', description: null });
      auditLog = await latestAuditLog();
      expect(auditLog.action).toBe('organization.permission_rule.update');
      expect(auditLog.message).toBe(
        'Updated final_deny permission rule bash "git push *" to specific_deny permission rule bash "git push *"'
      );

      await caller.organizations.permissionRules.delete({ organizationId, ruleId: deny.rule.id });
      auditLog = await latestAuditLog();
      expect(auditLog.action).toBe('organization.permission_rule.remove');
      const after = await caller.organizations.permissionRules.list({ organizationId });
      expect(after.rules).toHaveLength(1);
    });

    it('records preset sources and rejects client event approvals', async () => {
      const caller = await createCallerForUser(owner.id);
      const input = { organizationId, tier: 'broad_allow' as const, permission: 'bash' };
      const preset = await caller.organizations.permissionRules.add({
        ...input,
        pattern: 'git status *',
        source: 'preset',
      });
      expect(preset.rule.source).toEqual({ type: 'preset' });
      await expect(
        caller.organizations.permissionRules.add({
          ...input,
          pattern: 'git diff *',
          // @ts-expect-error event approvals are server-only
          source: 'event_approval',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('returns validation warnings for broad narrow allows', async () => {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.permissionRules.add({
        organizationId,
        tier: 'narrow_allow',
        permission: 'bash',
        pattern: 'git *',
      });
      expect(result.warnings).toHaveLength(1);
    });

    it('rejects invalid rules', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.permissionRules.add({
          organizationId,
          tier: 'final_deny',
          permission: 'read',
          pattern: 'src/*',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.organizations.permissionRules.add({
          organizationId,
          tier: 'broad_allow',
          permission: '*',
          pattern: '*',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const { rule } = await caller.organizations.permissionRules.add({
        organizationId,
        tier: 'final_deny',
        permission: 'read',
        pattern: '*',
      });
      await expect(
        caller.organizations.permissionRules.update({
          organizationId,
          ruleId: rule.id,
          pattern: 'src/*',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects duplicates on add and update', async () => {
      const caller = await createCallerForUser(owner.id);
      const input = {
        organizationId,
        tier: 'final_deny' as const,
        permission: 'bash',
        pattern: 'rm *',
      };
      await caller.organizations.permissionRules.add(input);
      await expect(caller.organizations.permissionRules.add(input)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      const { rule } = await caller.organizations.permissionRules.add({
        ...input,
        pattern: 'rmdir *',
      });
      await expect(
        caller.organizations.permissionRules.update({
          organizationId,
          ruleId: rule.id,
          pattern: 'rm *',
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('enforces the per-organization cap', async () => {
      await db.insert(organization_permission_rules).values(
        Array.from({ length: MAX_ORGANIZATION_PERMISSION_RULES }, (_, index) => ({
          organization_id: organizationId,
          tier: 'final_deny' as const,
          permission: 'bash',
          pattern: `cmd${index} *`,
          source: { type: 'admin_ui' as const },
        }))
      );
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.permissionRules.add({
          organizationId,
          tier: 'final_deny',
          permission: 'bash',
          pattern: 'one-more *',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('does not touch rules of another organization', async () => {
      const caller = await createCallerForUser(owner.id);
      const { rule } = await caller.organizations.permissionRules.add({
        organizationId: otherOrganizationId,
        tier: 'final_deny',
        permission: 'bash',
        pattern: 'rm *',
      });
      await expect(
        caller.organizations.permissionRules.update({
          organizationId,
          ruleId: rule.id,
          pattern: 'rmdir *',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.organizations.permissionRules.delete({ organizationId, ruleId: rule.id })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const other = await caller.organizations.permissionRules.list({
        organizationId: otherOrganizationId,
      });
      expect(other.rules).toEqual([expect.objectContaining({ id: rule.id, pattern: 'rm *' })]);
      const own = await caller.organizations.permissionRules.list({ organizationId });
      expect(own.rules).toEqual([]);
    });
  });

  describe('preview', () => {
    it('returns the deciding rule or the default effect', async () => {
      const caller = await createCallerForUser(owner.id);
      await caller.organizations.permissionRules.add({
        organizationId,
        tier: 'specific_deny',
        permission: 'bash',
        pattern: 'git push *',
      });
      const { rule: allow } = await caller.organizations.permissionRules.add({
        organizationId,
        tier: 'narrow_allow',
        permission: 'bash',
        pattern: 'git push origin *',
      });
      await expect(
        caller.organizations.permissionRules.preview({
          organizationId,
          permission: 'bash',
          pattern: 'git push origin main',
        })
      ).resolves.toMatchObject({ decision: 'allow', rule: { id: allow.id } });
      await expect(
        caller.organizations.permissionRules.preview({
          organizationId,
          permission: 'bash',
          pattern: 'git push upstream main',
        })
      ).resolves.toMatchObject({ decision: 'deny', rule: { tier: 'specific_deny' } });
      await expect(
        caller.organizations.permissionRules.preview({
          organizationId,
          permission: 'bash',
          pattern: 'ls',
        })
      ).resolves.toMatchObject({ decision: 'allow', rule: null });
    });
  });

  describe('usage events', () => {
    it('aggregates by permission and command key, flags existing rules, and filters', async () => {
      await insertEvent({ count: 3 });
      await insertEvent({ count: 2, client: 'vscode' });
      await insertEvent({ count: 1, decision: 'allowed', kilo_user_id: owner.id });
      await insertEvent({ command_key: 'git status', decision: 'allowed', count: 5 });
      await insertEvent({ command_key: 'old', day: today(40) });
      await insertEvent({ organization_id: otherOrganizationId, command_key: 'secret' });
      const caller = await createCallerForUser(owner.id);
      await caller.organizations.permissionRules.add({
        organizationId,
        tier: 'broad_allow',
        permission: 'bash',
        pattern: 'git status *',
      });

      const result = await caller.organizations.permissionRules.listEvents({ organizationId });
      expect(result.nextCursor).toBeNull();
      const byKey = new Map(result.events.map(event => [event.commandKey, event]));
      expect([...byKey.keys()].sort()).toEqual(['git push', 'git status']);
      expect(byKey.get('git push')).toMatchObject({
        permission: 'bash',
        deniedCount: 5,
        allowedCount: 1,
        askedCount: 0,
        users: 2,
        hasRule: false,
      });
      expect(byKey.get('git push')?.clients.sort()).toEqual(['cli', 'vscode']);
      expect(byKey.get('git status')).toMatchObject({ allowedCount: 5, hasRule: true });

      const denied = await caller.organizations.permissionRules.listEvents({
        organizationId,
        decision: 'denied',
        client: 'vscode',
      });
      expect(denied.events).toEqual([
        expect.objectContaining({ commandKey: 'git push', deniedCount: 2, users: 1 }),
      ]);

      const wide = await caller.organizations.permissionRules.listEvents({
        organizationId,
        days: 90,
      });
      expect(wide.events.map(event => event.commandKey)).toContain('old');

      const users = await caller.organizations.permissionRules.eventUsers({
        organizationId,
        permission: 'bash',
        commandKey: 'git push',
      });
      expect(users.users).toHaveLength(3);
      expect(users.users).toContainEqual(
        expect.objectContaining({ userId: member.id, client: 'cli', decision: 'denied', uses: 3 })
      );
    });

    it('approves an event as a narrow allow', async () => {
      await insertEvent();
      await insertEvent({ permission: 'webfetch', command_key: '*' });
      const caller = await createCallerForUser(owner.id);

      const { rule } = await caller.organizations.permissionRules.approveEvent({
        organizationId,
        permission: 'bash',
        commandKey: 'git push',
      });
      expect(rule).toMatchObject({
        tier: 'narrow_allow',
        permission: 'bash',
        pattern: 'git push *',
        source: { type: 'event_approval' },
      });
      const auditLog = await latestAuditLog();
      expect(auditLog.action).toBe('organization.permission_rule.add');
      expect(auditLog.message).toBe('Approved narrow_allow permission rule bash "git push *"');

      const tool = await caller.organizations.permissionRules.approveEvent({
        organizationId,
        permission: 'webfetch',
        commandKey: '*',
      });
      expect(tool.rule.pattern).toBe('*');

      await expect(
        caller.organizations.permissionRules.approveEvent({
          organizationId,
          permission: 'bash',
          commandKey: 'git push',
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const listed = await caller.organizations.permissionRules.listEvents({ organizationId });
      expect(listed.events.every(event => event.hasRule)).toBe(true);
    });

    it('does not approve keys seen only in another organization', async () => {
      await insertEvent({ organization_id: otherOrganizationId });
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.permissionRules.approveEvent({
          organizationId,
          permission: 'bash',
          commandKey: 'git push',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
