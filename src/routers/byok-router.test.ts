import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { db } from '@/lib/drizzle';
import { byok_api_keys, organization_audit_logs } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';

describe('BYOK Router', () => {
  let ownerUser: User;
  let memberUser: User;
  let otherOrgOwner: User;
  let organizationA: Organization;
  let organizationB: Organization;

  beforeAll(async () => {
    // Create test users
    ownerUser = await insertTestUser({
      google_user_email: 'byok-owner@example.com',
      google_user_name: 'BYOK Owner',
    });

    memberUser = await insertTestUser({
      google_user_email: 'byok-member@example.com',
      google_user_name: 'BYOK Member',
    });

    otherOrgOwner = await insertTestUser({
      google_user_email: 'byok-other-owner@example.com',
      google_user_name: 'Other Org Owner',
    });

    // Create test organizations
    organizationA = await createTestOrganization('BYOK Test Org A', ownerUser.id, 100000);
    organizationB = await createTestOrganization('BYOK Test Org B', otherOrgOwner.id, 100000);

    // Add member to organization A
    await addUserToOrganization(organizationA.id, memberUser.id, 'member');
  });

  afterEach(async () => {
    // Clean up BYOK keys after each test
    await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, organizationA.id));
    await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, organizationB.id));
  });

  describe('list', () => {
    test('should return empty array when organization has no keys', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.byok.list({ organizationId: organizationA.id });

      expect(result).toEqual([]);
    });

    test('should return keys for organization', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      // Create a key
      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'test-api-key-123',
      });

      // List keys
      const result = await caller.byok.list({ organizationId: organizationA.id });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(created.id);
      expect(result[0].provider_id).toBe('anthropic');
      expect(result[0].provider_name).toBe('anthropic');
      expect(result[0].created_by).toBe(ownerUser.id);
    });

    test('should allow members to list keys', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);

      // Owner creates a key
      await ownerCaller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'test-openai-key',
      });

      // Member can list keys
      const result = await memberCaller.byok.list({ organizationId: organizationA.id });

      expect(result).toHaveLength(1);
      expect(result[0].provider_id).toBe('openai');
    });

    test('should only return keys for specified organization', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create keys in both organizations
      await callerA.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'key-org-a',
      });

      await callerB.byok.create({
        organizationId: organizationB.id,
        provider_id: 'openai',
        api_key: 'key-org-b',
      });

      // List keys for org A
      const resultA = await callerA.byok.list({ organizationId: organizationA.id });
      expect(resultA).toHaveLength(1);
      expect(resultA[0].provider_id).toBe('anthropic');

      // List keys for org B
      const resultB = await callerB.byok.list({ organizationId: organizationB.id });
      expect(resultB).toHaveLength(1);
      expect(resultB[0].provider_id).toBe('openai');
    });

    test('should throw UNAUTHORIZED when user is not a member', async () => {
      const caller = await createCallerForUser(otherOrgOwner.id);

      await expect(caller.byok.list({ organizationId: organizationA.id })).rejects.toThrow(
        'You do not have access to this organization'
      );
    });
  });

  describe('create', () => {
    test('should create a new BYOK key', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const result = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'sk-ant-test-key-123',
      });

      expect(result.id).toBeDefined();
      expect(result.provider_id).toBe('anthropic');
      expect(result.provider_name).toBe('anthropic');
      expect(result.created_by).toBe(ownerUser.id);
      expect(result.created_at).toBeDefined();
      expect(result.updated_at).toBeDefined();

      // Verify key is encrypted in database
      const [dbKey] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, result.id));

      expect(dbKey).toBeDefined();
      expect(dbKey.encrypted_api_key).toBeDefined();
      expect(typeof dbKey.encrypted_api_key).toBe('object');
      expect(dbKey.encrypted_api_key).toHaveProperty('iv');
      expect(dbKey.encrypted_api_key).toHaveProperty('data');
      expect(dbKey.encrypted_api_key).toHaveProperty('authTag');
    });

    test('should create audit log entry', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'sk-test-key',
      });

      // Check audit log
      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, organizationA.id),
            eq(organization_audit_logs.action, 'organization.settings.change')
          )
        );

      const relevantLog = logs.find(log =>
        log.message.includes('Added BYOK key for provider: openai')
      );
      expect(relevantLog).toBeDefined();
      expect(relevantLog?.actor_id).toBe(ownerUser.id);
      expect(relevantLog?.actor_email).toBe(ownerUser.google_user_email);
    });

    test('should throw UNAUTHORIZED when user is not an owner', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'anthropic',
          api_key: 'test-key',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    test('should throw UNAUTHORIZED when user is not a member of organization', async () => {
      const caller = await createCallerForUser(otherOrgOwner.id);

      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'anthropic',
          api_key: 'test-key',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    test('should allow multiple keys for different providers', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const key1 = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'anthropic-key',
      });

      const key2 = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'openai-key',
      });

      expect(key1.provider_id).toBe('anthropic');
      expect(key2.provider_id).toBe('openai');

      const keys = await caller.byok.list({ organizationId: organizationA.id });
      expect(keys).toHaveLength(2);
    });
  });

  describe('update', () => {
    test('should update an existing BYOK key', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      // Create a key
      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'old-key',
      });

      // Update the key
      const updated = await caller.byok.update({
        organizationId: organizationA.id,
        id: created.id,
        api_key: 'new-key',
      });

      expect(updated.id).toBe(created.id);
      expect(updated.provider_id).toBe('anthropic');
      expect(updated.updated_at).not.toBe(created.updated_at);

      // Verify encryption changed
      const [dbKey] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, created.id));

      expect(dbKey.encrypted_api_key).toBeDefined();
      expect(typeof dbKey.encrypted_api_key).toBe('object');
      expect(dbKey.encrypted_api_key).toHaveProperty('iv');
      expect(dbKey.encrypted_api_key).toHaveProperty('data');
    });

    test('should create audit log entry for update', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'original-key',
      });

      await caller.byok.update({
        organizationId: organizationA.id,
        id: created.id,
        api_key: 'updated-key',
      });

      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, organizationA.id),
            eq(organization_audit_logs.action, 'organization.settings.change')
          )
        );

      const updateLog = logs.find(log =>
        log.message.includes('Updated BYOK key for provider: openai')
      );
      expect(updateLog).toBeDefined();
    });

    test('should throw NOT_FOUND when key does not exist', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      await expect(
        caller.byok.update({
          organizationId: organizationA.id,
          id: nonExistentId,
          api_key: 'new-key',
        })
      ).rejects.toThrow('BYOK key not found');
    });

    test('should throw UNAUTHORIZED when user is not an owner', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);

      const created = await ownerCaller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'test-key',
      });

      await expect(
        memberCaller.byok.update({
          organizationId: organizationA.id,
          id: created.id,
          api_key: 'new-key',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    test('should prevent updating key from different organization', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org A
      const keyA = await callerA.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'org-a-key',
      });

      // Try to update org A's key from org B (should fail authorization check)
      await expect(
        callerB.byok.update({
          organizationId: organizationB.id,
          id: keyA.id,
          api_key: 'malicious-key',
        })
      ).rejects.toThrow('BYOK key not found');

      // Verify key was not updated
      const [dbKey] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, keyA.id));

      expect(dbKey.organization_id).toBe(organizationA.id);
    });
  });

  describe('delete', () => {
    test('should delete a BYOK key', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'test-key',
      });

      const result = await caller.byok.delete({
        organizationId: organizationA.id,
        id: created.id,
      });

      expect(result.success).toBe(true);

      // Verify key is deleted
      const keys = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, created.id));

      expect(keys).toHaveLength(0);
    });

    test('should create audit log entry for deletion', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'test-key',
      });

      await caller.byok.delete({
        organizationId: organizationA.id,
        id: created.id,
      });

      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, organizationA.id),
            eq(organization_audit_logs.action, 'organization.settings.change')
          )
        );

      const deleteLog = logs.find(log =>
        log.message.includes('Deleted BYOK key for provider: openai')
      );
      expect(deleteLog).toBeDefined();
    });

    test('should throw NOT_FOUND when key does not exist', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      await expect(
        caller.byok.delete({
          organizationId: organizationA.id,
          id: nonExistentId,
        })
      ).rejects.toThrow('BYOK key not found');
    });

    test('should throw UNAUTHORIZED when user is not an owner', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);

      const created = await ownerCaller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'test-key',
      });

      await expect(
        memberCaller.byok.delete({
          organizationId: organizationA.id,
          id: created.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    test('should prevent deleting key from different organization', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org A
      const keyA = await callerA.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'org-a-key',
      });

      // Try to delete org A's key from org B (should fail)
      await expect(
        callerB.byok.delete({
          organizationId: organizationB.id,
          id: keyA.id,
        })
      ).rejects.toThrow('BYOK key not found');

      // Verify key still exists
      const keys = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, keyA.id));

      expect(keys).toHaveLength(1);
    });
  });

  describe('cross-organization security', () => {
    test('should not allow user from org A to access keys from org B', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org B
      await callerB.byok.create({
        organizationId: organizationB.id,
        provider_id: 'anthropic',
        api_key: 'org-b-secret-key',
      });

      // User from org A should not see org B's keys
      await expect(callerA.byok.list({ organizationId: organizationB.id })).rejects.toThrow(
        'You do not have access to this organization'
      );
    });

    test('should not allow user from org A to update keys from org B', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org B
      const keyB = await callerB.byok.create({
        organizationId: organizationB.id,
        provider_id: 'openai',
        api_key: 'org-b-key',
      });

      // User from org A tries to update org B's key
      await expect(
        callerA.byok.update({
          organizationId: organizationA.id,
          id: keyB.id,
          api_key: 'malicious-update',
        })
      ).rejects.toThrow('BYOK key not found');
    });

    test('should not allow user from org A to delete keys from org B', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org B
      const keyB = await callerB.byok.create({
        organizationId: organizationB.id,
        provider_id: 'anthropic',
        api_key: 'org-b-key',
      });

      // User from org A tries to delete org B's key (using wrong org ID)
      await expect(
        callerA.byok.delete({
          organizationId: organizationB.id,
          id: keyB.id,
        })
      ).rejects.toThrow('You do not have access to this organization');

      // Verify key still exists
      const keys = await callerB.byok.list({ organizationId: organizationB.id });
      expect(keys).toHaveLength(1);
    });
  });
});
