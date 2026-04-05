import { describe, test, expect, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from './organizations';
import { createOrganizationMode, getAllOrganizationModes } from './organization-modes';

describe('createOrganizationMode', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  test('should create a basic organization mode', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const mode = await createOrganizationMode(organization.id, user.id, 'Code Mode', 'code');

    expect(mode).not.toBeNull();
    expect(mode?.id).toBeDefined();
    expect(mode?.organization_id).toBe(organization.id);
    expect(mode?.created_by).toBe(user.id);
    expect(mode?.name).toBe('Code Mode');
    expect(mode?.slug).toBe('code');
    expect(mode?.config).toEqual({
      groups: [],
      roleDefinition: 'default',
    });
    expect(mode?.created_at).toBeDefined();
    expect(mode?.updated_at).toBeDefined();
  });

  test('should create organization mode with custom config', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const customConfig = {
      roleDefinition: 'You are a helpful assistant',
      description: 'A custom mode for testing',
      groups: ['read', 'edit'] as ('read' | 'edit' | 'browser' | 'command' | 'mcp')[],
    };

    const mode = await createOrganizationMode(
      organization.id,
      user.id,
      'Custom Mode',
      'custom',
      customConfig
    );

    expect(mode).not.toBeNull();
    expect(mode?.name).toBe('Custom Mode');
    expect(mode?.slug).toBe('custom');
    expect(mode?.config).toEqual(customConfig);
  });

  test('should create multiple modes for same organization', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const mode1 = await createOrganizationMode(organization.id, user.id, 'Code Mode', 'code');

    const mode2 = await createOrganizationMode(organization.id, user.id, 'Debug Mode', 'debug');

    expect(mode1).not.toBeNull();
    expect(mode2).not.toBeNull();
    expect(mode1?.id).not.toBe(mode2?.id);
    expect(mode1?.slug).toBe('code');
    expect(mode2?.slug).toBe('debug');
    expect(mode1?.organization_id).toBe(organization.id);
    expect(mode2?.organization_id).toBe(organization.id);
  });

  test('should preserve timestamps on creation', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const beforeCreate = new Date();
    const mode = await createOrganizationMode(organization.id, user.id, 'Tester Mode', 'test');

    expect(mode).not.toBeNull();
    const createdAt = new Date(mode!.created_at);
    const updatedAt = new Date(mode!.updated_at);

    expect(createdAt.getTime()).toBeCloseTo(beforeCreate.getTime(), -3);
    expect(updatedAt.getTime()).toBe(createdAt.getTime());
  });

  test('should handle empty string config values', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const config = {
      roleDefinition: '',
      description: '',
      whenToUse: '',
      customInstructions: '',
      groups: [] as ('read' | 'edit' | 'browser' | 'command' | 'mcp')[],
    };

    const mode = await createOrganizationMode(
      organization.id,
      user.id,
      'Empty Config Mode',
      'empty',
      config
    );

    expect(mode).not.toBeNull();
    expect(mode?.config).toEqual(config);
  });

  test('should handle complete config with all fields', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const config = {
      roleDefinition: 'You are a code reviewer',
      whenToUse: 'Use this mode when reviewing code',
      description: 'A mode for thorough code review',
      customInstructions: 'Focus on security and performance',
      groups: ['read', 'edit', 'browser'] as ('read' | 'edit' | 'browser' | 'command' | 'mcp')[],
    };

    const mode = await createOrganizationMode(
      organization.id,
      user.id,
      'Complete Config Mode',
      'complete',
      config
    );

    expect(mode).not.toBeNull();
    expect(mode?.config).toEqual(config);
  });
});

describe('getAllOrganizationModes', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  test('should return empty array when organization has no modes', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const modes = await getAllOrganizationModes(organization.id);

    expect(modes).toEqual([]);
  });

  test('should return all modes for an organization', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    await createOrganizationMode(organization.id, user.id, 'Code Mode', 'code');

    await createOrganizationMode(organization.id, user.id, 'Debug Mode', 'debug');

    await createOrganizationMode(organization.id, user.id, 'Architect Mode', 'architect');

    const modes = await getAllOrganizationModes(organization.id);

    expect(modes).toHaveLength(3);
    expect(modes.map(m => m.slug).sort()).toEqual(['architect', 'code', 'debug']);
    expect(modes.every(m => m.organization_id === organization.id)).toBe(true);
  });

  test('should only return modes for specified organization', async () => {
    const user1 = await insertTestUser();
    const user2 = await insertTestUser();
    const org1 = await createOrganization('Org 1', user1.id);
    const org2 = await createOrganization('Org 2', user2.id);

    await createOrganizationMode(org1.id, user1.id, 'Org1 Mode 1', 'org1-mode1');
    await createOrganizationMode(org1.id, user1.id, 'Org1 Mode 2', 'org1-mode2');
    await createOrganizationMode(org2.id, user2.id, 'Org2 Mode 1', 'org2-mode1');

    const org1Modes = await getAllOrganizationModes(org1.id);
    const org2Modes = await getAllOrganizationModes(org2.id);

    expect(org1Modes).toHaveLength(2);
    expect(org2Modes).toHaveLength(1);

    expect(org1Modes.every(m => m.organization_id === org1.id)).toBe(true);
    expect(org2Modes.every(m => m.organization_id === org2.id)).toBe(true);

    expect(org1Modes.map(m => m.slug).sort()).toEqual(['org1-mode1', 'org1-mode2']);
    expect(org2Modes.map(m => m.slug)).toEqual(['org2-mode1']);
  });

  test('should return modes with all expected fields', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const config = {
      roleDefinition: 'Test role',
      groups: ['read'] as ('read' | 'edit' | 'browser' | 'command' | 'mcp')[],
    };
    await createOrganizationMode(organization.id, user.id, 'Test Mode', 'test', config);

    const modes = await getAllOrganizationModes(organization.id);

    expect(modes).toHaveLength(1);
    const mode = modes[0];

    expect(mode).toHaveProperty('id');
    expect(mode).toHaveProperty('organization_id', organization.id);
    expect(mode).toHaveProperty('name', 'Test Mode');
    expect(mode).toHaveProperty('slug', 'test');
    expect(mode).toHaveProperty('created_by', user.id);
    expect(mode).toHaveProperty('created_at');
    expect(mode).toHaveProperty('updated_at');
    expect(mode).toHaveProperty('config', config);
  });

  test('should handle organization with many modes', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const modeCount = 20;
    for (let i = 0; i < modeCount; i++) {
      await createOrganizationMode(organization.id, user.id, `Mode ${i}`, `mode-${i}`);
    }

    const modes = await getAllOrganizationModes(organization.id);

    expect(modes).toHaveLength(modeCount);
    expect(modes.every(m => m.organization_id === organization.id)).toBe(true);
  });

  test('should return modes in database insertion order', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const mode1 = await createOrganizationMode(organization.id, user.id, 'First Mode', 'first');

    await new Promise(resolve => setTimeout(resolve, 10));

    const mode2 = await createOrganizationMode(organization.id, user.id, 'Second Mode', 'second');

    await new Promise(resolve => setTimeout(resolve, 10));

    const mode3 = await createOrganizationMode(organization.id, user.id, 'Third Mode', 'third');

    const modes = await getAllOrganizationModes(organization.id);

    expect(modes).toHaveLength(3);
    expect(mode1).not.toBeNull();
    expect(mode2).not.toBeNull();
    expect(mode3).not.toBeNull();

    const mode1Created = new Date(mode1!.created_at);
    const mode2Created = new Date(mode2!.created_at);
    const mode3Created = new Date(mode3!.created_at);

    expect(mode1Created.getTime()).toBeLessThan(mode2Created.getTime());
    expect(mode2Created.getTime()).toBeLessThan(mode3Created.getTime());
  });

  test('should handle modes with different creators', async () => {
    const user1 = await insertTestUser();
    const user2 = await insertTestUser();
    const organization = await createOrganization('Test Org', user1.id);

    await createOrganizationMode(organization.id, user1.id, 'Mode by User1', 'user1-mode');

    await createOrganizationMode(organization.id, user2.id, 'Mode by User2', 'user2-mode');

    const modes = await getAllOrganizationModes(organization.id);

    expect(modes).toHaveLength(2);
    expect(modes.find(m => m.created_by === user1.id)).toBeDefined();
    expect(modes.find(m => m.created_by === user2.id)).toBeDefined();
  });
});
