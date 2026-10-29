import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  addUserToOrganization,
  getOrganizationById,
} from '@kilocode/web-shared/lib/organizations/organizations';
import {
  organization_addons,
  organization_audit_logs,
  organization_mcp_connect_events,
  type NewOrganizationMcpConnectEvent,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, desc, eq } from 'drizzle-orm';
import type { McpCatalogItem } from '@/lib/organizations/addons/catalog';

const mockBrowse = jest.fn();
const mockResolve = jest.fn();
const mockFindMatch = jest.fn();

jest.mock('@/lib/organizations/addons/catalog', () => ({
  browseMcpCatalog: (...args: unknown[]) => mockBrowse(...args),
  resolveMcpCatalogItem: (...args: unknown[]) => mockResolve(...args),
  findMcpCatalogMatch: (...args: unknown[]) => mockFindMatch(...args),
}));

const registryItem: McpCatalogItem = {
  source: 'mcp_registry',
  sourceId: 'io.example/server',
  name: 'Example Server',
  description: 'An example server',
  author: null,
  homepageUrl: null,
  variants: [
    {
      eligible: true,
      label: 'npm',
      identityKey: 'npm:@example/server',
      target: { kind: 'package', ecosystem: 'npm', identifier: '@example/server' },
      versionHint: '1.2.0',
    },
    {
      eligible: true,
      label: 'remote',
      identityKey: 'remote:https://mcp.example.com/mcp',
      target: { kind: 'remote', url: 'https://mcp.example.com/mcp' },
      versionHint: null,
    },
    { eligible: false, label: 'oci', reason: 'oci packages aren’t supported yet.' },
  ],
};

let owner: User;
let member: User;
let organizationId: string;
let otherOrganizationId: string;
let plainOrganizationId: string;

async function latestAuditLog() {
  const [auditLog] = await db
    .select()
    .from(organization_audit_logs)
    .where(eq(organization_audit_logs.organization_id, organizationId))
    .orderBy(desc(organization_audit_logs.created_at))
    .limit(1);
  return auditLog;
}

describe('organization addons router', () => {
  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'owner-addons@example.com',
      google_user_name: 'Owner Addons',
      is_admin: false,
    });
    member = await insertTestUser({
      google_user_email: 'member-addons@example.com',
      google_user_name: 'Member Addons',
      is_admin: false,
    });
    const organization = await createTestOrganization(
      'Addons Org',
      owner.id,
      0,
      { kilo_encrypt: true },
      false
    );
    organizationId = organization.id;
    await addUserToOrganization(organizationId, member.id, 'member');
    otherOrganizationId = (
      await createTestOrganization('Other Addons Org', owner.id, 0, { kilo_encrypt: true }, false)
    ).id;
    plainOrganizationId = (await createTestOrganization('Plain Org', owner.id, 0, {}, false)).id;
  });

  beforeEach(async () => {
    mockBrowse.mockReset();
    mockResolve.mockReset();
    mockFindMatch.mockReset();
    await db
      .delete(organization_mcp_connect_events)
      .where(eq(organization_mcp_connect_events.organization_id, organizationId));
    await db
      .delete(organization_addons)
      .where(eq(organization_addons.organization_id, organizationId));
  });

  describe('access', () => {
    it('rejects members', async () => {
      const caller = await createCallerForUser(member.id);
      await expect(caller.organizations.addons.list({ organizationId })).rejects.toThrow();
    });

    it('rejects organizations without AI Guardrails access', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.addons.list({ organizationId: plainOrganizationId })
      ).rejects.toThrow('AI Guardrails is not available for this organization.');
      await expect(
        caller.organizations.addons.add({
          organizationId: plainOrganizationId,
          type: 'mcp',
          source: 'custom',
          target: { kind: 'remote', url: 'https://mcp.example.com/mcp' },
        })
      ).rejects.toThrow('AI Guardrails is not available for this organization.');
    });
  });

  describe('enforcement', () => {
    it('defaults to allowing everything', async () => {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.addons.list({ organizationId });
      expect(result.enforcement).toEqual({
        mcp: 'off',
        skill: { enabled: false, scanBeforeUse: true },
      });
      expect(result.addons).toEqual([]);
    });

    it('persists the MCP mode, keeps other settings, and audits it', async () => {
      const caller = await createCallerForUser(owner.id);

      await caller.organizations.addons.setEnforcement({
        organizationId,
        type: 'mcp',
        enforcement: 'shadow',
      });

      const result = await caller.organizations.addons.list({ organizationId });
      expect(result.enforcement.mcp).toBe('shadow');
      expect(result.enforcement.skill).toEqual({ enabled: false, scanBeforeUse: true });
      const organization = await getOrganizationById(organizationId);
      expect(organization?.settings).toEqual(
        expect.objectContaining({
          kilo_encrypt: true,
          addon_guardrails: { mcp: { enforcement: 'shadow' } },
        })
      );
      const auditLog = await latestAuditLog();
      expect(auditLog.action).toBe('organization.settings.change');
      expect(auditLog.message).toBe('Set MCP server enforcement to shadow');
    });

    it('persists the skill guardrails independently of the MCP mode', async () => {
      const caller = await createCallerForUser(owner.id);
      await caller.organizations.addons.setEnforcement({
        organizationId,
        type: 'mcp',
        enforcement: 'enforce',
      });

      await caller.organizations.addons.setEnforcement({
        organizationId,
        type: 'skill',
        enabled: true,
        scanBeforeUse: false,
      });

      const result = await caller.organizations.addons.list({ organizationId });
      expect(result.enforcement).toEqual({
        mcp: 'enforce',
        skill: { enabled: true, scanBeforeUse: false },
      });
      const organization = await getOrganizationById(organizationId);
      expect(organization?.settings.addon_guardrails).toEqual({
        mcp: { enforcement: 'enforce' },
        skill: { enabled: true, scan_before_use: false },
      });
      const auditLog = await latestAuditLog();
      expect(auditLog.message).toBe('Set skill guardrails to enabled, scan before use off');
    });

    it('rejects an unknown mode', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.addons.setEnforcement({
          organizationId,
          type: 'mcp',
          enforcement: 'block' as 'off',
        })
      ).rejects.toThrow();
      await expect(
        caller.organizations.addons.setEnforcement({
          organizationId,
          type: 'skill',
          enabled: 'yes' as unknown as boolean,
          scanBeforeUse: true,
        })
      ).rejects.toThrow();
    });
  });

  describe('add', () => {
    it('adds a custom remote server with a normalized URL', async () => {
      const caller = await createCallerForUser(owner.id);

      const added = await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'custom',
        target: { kind: 'remote', url: 'https://MCP.Example.com/mcp/?token=secret#x' },
      });

      expect(added).toMatchObject({
        type: 'mcp',
        identityKey: 'remote:https://mcp.example.com/mcp',
        name: 'mcp.example.com',
        status: 'enabled',
        config: { kind: 'remote', url: 'https://mcp.example.com/mcp' },
        source: { registry: 'custom', id: null },
      });
      expect(JSON.stringify(added)).not.toContain('secret');
      const auditLog = await latestAuditLog();
      expect(auditLog.action).toBe('organization.addon.add');
      expect(auditLog.message).toBe(
        'Added MCP server mcp.example.com (remote:https://mcp.example.com/mcp)'
      );
    });

    it('adds a custom package with a minimum version', async () => {
      const caller = await createCallerForUser(owner.id);

      const added = await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'custom',
        name: 'Filesystem',
        target: {
          kind: 'package',
          ecosystem: 'npm',
          identifier: '@modelcontextprotocol/server-filesystem',
        },
        minVersion: ' 2025.1.0 ',
      });

      expect(added).toMatchObject({
        name: 'Filesystem',
        identityKey: 'npm:@modelcontextprotocol/server-filesystem',
        config: {
          kind: 'package',
          ecosystem: 'npm',
          identifier: '@modelcontextprotocol/server-filesystem',
          min_version: '2025.1.0',
        },
      });
    });

    it.each([
      { kind: 'remote', url: 'http://mcp.example.com' },
      { kind: 'remote', url: 'https://user:pw@mcp.example.com' },
      { kind: 'package', ecosystem: 'npm', identifier: 'github:evil/repo' },
      { kind: 'package', ecosystem: 'pypi', identifier: 'git+https://evil.example/x' },
    ] as const)('rejects custom target %j', async target => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.addons.add({
          organizationId,
          type: 'mcp',
          source: 'custom',
          target,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects an invalid minimum version', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.addons.add({
          organizationId,
          type: 'mcp',
          source: 'custom',
          target: { kind: 'package', ecosystem: 'npm', identifier: 'pkg' },
          minVersion: '^1.0.0',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects a duplicate identity, including the same PyPI package spelled differently', async () => {
      const caller = await createCallerForUser(owner.id);
      await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'custom',
        target: { kind: 'package', ecosystem: 'pypi', identifier: 'Foo.Bar' },
      });

      await expect(
        caller.organizations.addons.add({
          organizationId,
          type: 'mcp',
          source: 'custom',
          target: { kind: 'package', ecosystem: 'pypi', identifier: 'foo-bar' },
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('allows the same identity in different organizations', async () => {
      const caller = await createCallerForUser(owner.id);
      const target = { kind: 'remote', url: 'https://mcp.example.com/mcp' } as const;
      await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'custom',
        target,
      });
      await expect(
        caller.organizations.addons.add({
          organizationId: otherOrganizationId,
          type: 'mcp',
          source: 'custom',
          target,
        })
      ).resolves.toMatchObject({ identityKey: 'remote:https://mcp.example.com/mcp' });
    });

    it('derives the target from the registry, not from the client', async () => {
      mockResolve.mockResolvedValue(registryItem);
      const caller = await createCallerForUser(owner.id);

      const added = await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'mcp_registry',
        sourceId: 'io.example/server',
        identityKey: 'npm:@example/server',
        minVersion: '1.2.0',
      });

      expect(mockResolve).toHaveBeenCalledWith({
        source: 'mcp_registry',
        sourceId: 'io.example/server',
      });
      expect(added).toMatchObject({
        name: 'Example Server',
        description: 'An example server',
        identityKey: 'npm:@example/server',
        config: { kind: 'package', identifier: '@example/server', min_version: '1.2.0' },
        source: { registry: 'mcp_registry', id: 'io.example/server' },
      });
    });

    it('ignores a minimum version for remote servers', async () => {
      mockResolve.mockResolvedValue(registryItem);
      const caller = await createCallerForUser(owner.id);

      const added = await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'mcp_registry',
        sourceId: 'io.example/server',
        identityKey: 'remote:https://mcp.example.com/mcp',
        minVersion: '1.0.0',
      });

      expect(added.config).toEqual({ kind: 'remote', url: 'https://mcp.example.com/mcp' });
    });

    it('rejects an identity the registry no longer offers or marks ineligible', async () => {
      mockResolve.mockResolvedValue(registryItem);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.addons.add({
          organizationId,
          type: 'mcp',
          source: 'mcp_registry',
          sourceId: 'io.example/server',
          identityKey: 'npm:@example/other',
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('reports a server that left the registry', async () => {
      mockResolve.mockResolvedValue(null);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.addons.add({
          organizationId,
          type: 'mcp',
          source: 'kilo_marketplace',
          sourceId: 'gone',
          identityKey: 'npm:gone',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('turns a registry outage into a retryable error', async () => {
      mockResolve.mockRejectedValue(new Error('boom'));
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.addons.add({
          organizationId,
          type: 'mcp',
          source: 'mcp_registry',
          sourceId: 'io.example/server',
          identityKey: 'npm:@example/server',
        })
      ).rejects.toMatchObject({
        code: 'BAD_GATEWAY',
        message: 'The registry couldn’t be reached. Try again.',
      });
    });
  });

  describe('browse', () => {
    it('flags variants that are already on the list', async () => {
      const caller = await createCallerForUser(owner.id);
      await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'custom',
        target: { kind: 'package', ecosystem: 'npm', identifier: '@example/server' },
      });
      mockBrowse.mockResolvedValue({ items: [registryItem], nextCursor: 'next' });

      const page = await caller.organizations.addons.browse({
        organizationId,
        type: 'mcp',
        source: 'mcp_registry',
        query: 'example',
      });

      expect(mockBrowse).toHaveBeenCalledWith({
        source: 'mcp_registry',
        query: 'example',
        cursor: null,
      });
      expect(page.nextCursor).toBe('next');
      expect(page.items[0].variants).toEqual([
        expect.objectContaining({ identityKey: 'npm:@example/server', alreadyAdded: true }),
        expect.objectContaining({
          identityKey: 'remote:https://mcp.example.com/mcp',
          alreadyAdded: false,
        }),
        expect.objectContaining({ eligible: false, label: 'oci' }),
      ]);
    });

    it('turns a registry outage into a retryable error', async () => {
      mockBrowse.mockRejectedValue(new Error('boom'));
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.organizations.addons.browse({
          organizationId,
          type: 'mcp',
          source: 'kilo_marketplace',
          query: '',
        })
      ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    });
  });

  describe('update, status and delete', () => {
    async function addPackage() {
      const caller = await createCallerForUser(owner.id);
      const added = await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'custom',
        target: { kind: 'package', ecosystem: 'npm', identifier: 'pkg' },
        minVersion: '1.0.0',
      });
      return { caller, added };
    }

    it('updates the name, description and minimum version', async () => {
      const { caller, added } = await addPackage();

      const updated = await caller.organizations.addons.update({
        organizationId,
        addonId: added.id,
        name: 'Renamed',
        description: 'Why we allow it',
        minVersion: '2.0.0',
      });

      expect(updated).toMatchObject({
        name: 'Renamed',
        description: 'Why we allow it',
        config: { kind: 'package', identifier: 'pkg', min_version: '2.0.0' },
        identityKey: 'npm:pkg',
      });
      expect((await latestAuditLog()).action).toBe('organization.addon.update');
    });

    it('clears the minimum version', async () => {
      const { caller, added } = await addPackage();
      const updated = await caller.organizations.addons.update({
        organizationId,
        addonId: added.id,
        minVersion: '',
      });
      expect(updated.config).toMatchObject({ min_version: null });
    });

    it('rejects a minimum version on a remote server', async () => {
      const caller = await createCallerForUser(owner.id);
      const added = await caller.organizations.addons.add({
        organizationId,
        type: 'mcp',
        source: 'custom',
        target: { kind: 'remote', url: 'https://mcp.example.com/mcp' },
      });
      await expect(
        caller.organizations.addons.update({
          organizationId,
          addonId: added.id,
          minVersion: '1.0.0',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('disables and re-enables an add-on and audits each change', async () => {
      const { caller, added } = await addPackage();

      const disabled = await caller.organizations.addons.setStatus({
        organizationId,
        addonId: added.id,
        status: 'disabled',
      });
      expect(disabled.status).toBe('disabled');
      expect((await latestAuditLog()).message).toBe('Disabled MCP server pkg (npm:pkg)');

      const enabled = await caller.organizations.addons.setStatus({
        organizationId,
        addonId: added.id,
        status: 'enabled',
      });
      expect(enabled.status).toBe('enabled');
      expect((await latestAuditLog()).message).toBe('Enabled MCP server pkg (npm:pkg)');
    });

    it('deletes an add-on and audits it', async () => {
      const { caller, added } = await addPackage();

      await caller.organizations.addons.delete({ organizationId, addonId: added.id });

      const rows = await db
        .select()
        .from(organization_addons)
        .where(and(eq(organization_addons.id, added.id)));
      expect(rows).toEqual([]);
      expect((await latestAuditLog()).action).toBe('organization.addon.remove');
    });

    it('does not let an admin touch another organization’s add-on', async () => {
      const { caller, added } = await addPackage();

      await expect(
        caller.organizations.addons.delete({
          organizationId: otherOrganizationId,
          addonId: added.id,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.organizations.addons.setStatus({
          organizationId: otherOrganizationId,
          addonId: added.id,
          status: 'disabled',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lists add-ons sorted by name, ignoring case', async () => {
      const caller = await createCallerForUser(owner.id);
      for (const name of ['Zed', 'alpha', 'Mid']) {
        await caller.organizations.addons.add({
          organizationId,
          type: 'mcp',
          source: 'custom',
          name,
          target: { kind: 'package', ecosystem: 'npm', identifier: `pkg-${name.toLowerCase()}` },
        });
      }
      const result = await caller.organizations.addons.list({ organizationId });
      expect(result.addons.map(addon => addon.name)).toEqual(['alpha', 'Mid', 'Zed']);
    });
  });

  describe('connections', () => {
    const remoteTarget = { kind: 'remote', url: 'https://mcp.example.com/mcp' } as const;
    const packageTarget = {
      kind: 'package',
      ecosystem: 'npm',
      identifier: 'left-pad-mcp',
    } as const;

    function event(
      overrides: Partial<NewOrganizationMcpConnectEvent> &
        Pick<NewOrganizationMcpConnectEvent, 'decision'>
    ): NewOrganizationMcpConnectEvent {
      return {
        organization_id: organizationId,
        kilo_user_id: owner.id,
        client: 'cli',
        identity_key: 'remote:https://mcp.example.com/mcp',
        target: remoteTarget,
        server_name: 'example',
        ...overrides,
      };
    }

    async function seedEvents() {
      await db.insert(organization_mcp_connect_events).values([
        event({ decision: 'denied', kilo_user_id: owner.id, created_at: '2026-10-01T10:00:00Z' }),
        event({ decision: 'denied', kilo_user_id: owner.id, created_at: '2026-10-02T10:00:00Z' }),
        event({
          decision: 'denied',
          kilo_user_id: member.id,
          client: 'vscode',
          created_at: '2026-10-03T10:00:00Z',
        }),
        event({
          decision: 'allowed',
          kilo_user_id: member.id,
          client: 'cloud_agent',
          created_at: '2026-10-04T10:00:00Z',
        }),
        event({
          decision: 'denied',
          identity_key: 'npm:left-pad-mcp',
          target: packageTarget,
          server_name: null,
          created_at: '2026-10-05T10:00:00Z',
        }),
      ]);
    }

    it('aggregates events per server with distinct users per decision', async () => {
      await seedEvents();
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.addons.listConnections({ organizationId });

      expect(result.nextCursor).toBeNull();
      expect(result.connections).toEqual([
        expect.objectContaining({
          identityKey: 'npm:left-pad-mcp',
          target: packageTarget,
          serverName: null,
          clients: ['cli'],
          allowedUsers: 0,
          deniedUsers: 1,
          isOnAllowedList: false,
        }),
        expect.objectContaining({
          identityKey: 'remote:https://mcp.example.com/mcp',
          target: remoteTarget,
          serverName: 'example',
          clients: ['cli', 'cloud_agent', 'vscode'],
          allowedUsers: 1,
          deniedUsers: 2,
          lastSeenAt: '2026-10-04T10:00:00.000Z',
          isOnAllowedList: false,
        }),
      ]);
    });

    it('filters by decision and client', async () => {
      await seedEvents();
      const caller = await createCallerForUser(owner.id);

      const denied = await caller.organizations.addons.listConnections({
        organizationId,
        decision: 'denied',
      });
      expect(denied.connections).toHaveLength(2);
      expect(denied.connections[1]).toEqual(
        expect.objectContaining({ allowedUsers: 0, deniedUsers: 2, clients: ['cli', 'vscode'] })
      );

      const allowed = await caller.organizations.addons.listConnections({
        organizationId,
        decision: 'allowed',
      });
      expect(allowed.connections).toHaveLength(1);
      expect(allowed.connections[0]).toEqual(
        expect.objectContaining({ allowedUsers: 1, deniedUsers: 0, clients: ['cloud_agent'] })
      );

      const vscode = await caller.organizations.addons.listConnections({
        organizationId,
        client: 'vscode',
      });
      expect(vscode.connections).toHaveLength(1);
      expect(vscode.connections[0].deniedUsers).toBe(1);
    });

    it('lists the users behind a server with their names', async () => {
      await seedEvents();
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.addons.connectionUsers({
        organizationId,
        identityKey: 'remote:https://mcp.example.com/mcp',
        decision: 'denied',
      });

      expect(result.users).toEqual([
        expect.objectContaining({
          userId: member.id,
          name: 'Member Addons',
          email: 'member-addons@example.com',
          client: 'vscode',
          decision: 'denied',
          connects: 1,
        }),
        expect.objectContaining({
          userId: owner.id,
          name: 'Owner Addons',
          client: 'cli',
          decision: 'denied',
          connects: 2,
        }),
      ]);
    });

    it('does not expose events from other organizations or to members', async () => {
      await db
        .insert(organization_mcp_connect_events)
        .values(event({ decision: 'denied', organization_id: otherOrganizationId }));
      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.addons.listConnections({ organizationId });
      expect(result.connections).toEqual([]);

      const memberCaller = await createCallerForUser(member.id);
      await expect(
        memberCaller.organizations.addons.listConnections({ organizationId })
      ).rejects.toThrow();
    });

    it('approves a server as the matching registry entry', async () => {
      await seedEvents();
      mockFindMatch.mockResolvedValue({ item: registryItem, versionHint: null });
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.addons.approveConnection({
        organizationId,
        identityKey: 'remote:https://mcp.example.com/mcp',
      });

      expect(mockFindMatch).toHaveBeenCalledWith(remoteTarget);
      expect(result.matchedRegistry).toBe('mcp_registry');
      expect(result.addon).toEqual(
        expect.objectContaining({
          identityKey: 'remote:https://mcp.example.com/mcp',
          name: 'Example Server',
          source: { registry: 'mcp_registry', id: 'io.example/server' },
        })
      );
      const auditLog = await latestAuditLog();
      expect(auditLog.action).toBe('organization.addon.add');
      expect(auditLog.message).toMatch(/^Approved MCP server Example Server/);
      const listed = await caller.organizations.addons.listConnections({ organizationId });
      expect(
        listed.connections.find(row => row.identityKey === 'remote:https://mcp.example.com/mcp')
          ?.isOnAllowedList
      ).toBe(true);
    });

    it('approves a server without a registry match as a custom server', async () => {
      await seedEvents();
      mockFindMatch.mockResolvedValue(null);
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.addons.approveConnection({
        organizationId,
        identityKey: 'npm:left-pad-mcp',
      });

      expect(result.matchedRegistry).toBeNull();
      expect(result.addon).toEqual(
        expect.objectContaining({
          name: 'left-pad-mcp',
          source: { registry: 'custom', id: null },
          config: {
            kind: 'package',
            ecosystem: 'npm',
            identifier: 'left-pad-mcp',
            min_version: null,
          },
        })
      );
    });

    it('falls back to the package name when the recorded server name is blank', async () => {
      await db.insert(organization_mcp_connect_events).values(
        event({
          decision: 'denied',
          identity_key: 'npm:left-pad-mcp',
          target: packageTarget,
          server_name: '   ',
          created_at: '2026-10-05T10:00:00Z',
        })
      );
      mockFindMatch.mockResolvedValue(null);
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.addons.approveConnection({
        organizationId,
        identityKey: 'npm:left-pad-mcp',
      });

      expect(result.addon.name).toBe('left-pad-mcp');
    });

    it('rejects approving an unknown or already allowed server', async () => {
      await seedEvents();
      mockFindMatch.mockResolvedValue(null);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.addons.approveConnection({
          organizationId,
          identityKey: 'npm:never-seen',
        })
      ).rejects.toThrow('No connections found for this server.');

      await caller.organizations.addons.approveConnection({
        organizationId,
        identityKey: 'npm:left-pad-mcp',
      });
      await expect(
        caller.organizations.addons.approveConnection({
          organizationId,
          identityKey: 'npm:left-pad-mcp',
        })
      ).rejects.toThrow('This MCP server is already on the allow list.');
    });
  });
});
