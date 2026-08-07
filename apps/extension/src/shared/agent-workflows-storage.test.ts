/* eslint-disable max-lines -- Contract review repairs added tests for pathPrefix/startUrl clearing; splitting would obscure coverage. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKFLOW_SETTINGS,
  MAX_WORKFLOW_COUNT,
  MAX_WORKFLOW_SCRIPT_LENGTH,
} from './agent-workflows';
import type {
  AgentWorkflow,
  AgentWorkflowInput,
  AgentWorkflowSettings,
  PendingAgentWorkflowDraft,
} from './agent-workflows';
import {
  AGENT_WORKFLOWS_STORAGE_KEY,
  AgentWorkflowStoreFullError,
  PENDING_WORKFLOW_SAVE_STORAGE_KEY,
  WORKFLOW_SETTINGS_STORAGE_KEY,
  addAgentWorkflow,
  clearPendingWorkflowDraft,
  deleteAgentWorkflow,
  loadAgentWorkflows,
  loadPendingWorkflowDraft,
  loadWorkflowSettings,
  saveAgentWorkflows,
  savePendingWorkflowDraft,
  saveWorkflowSettings,
  updateAgentWorkflow,
} from './agent-workflows-storage';
import type { AgentWorkflowsStorageArea } from './agent-workflows-storage';

const createStorage = (): AgentWorkflowsStorageArea & {
  values: Map<string, unknown>;
} => {
  const values = new Map<string, unknown>();

  return {
    getItem: key => values.get(key),
    removeItem: key => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
    values,
  };
};

const baseInput: AgentWorkflowInput = {
  description: 'Test workflow',
  name: 'Test',
  scopeOrigin: 'https://example.com',
  script: 'return { done: true, result: 1 };',
};

const baseCreate = (
  storage: ReturnType<typeof createStorage>,
  overrides?: Partial<AgentWorkflowInput>
): Promise<AgentWorkflow> => addAgentWorkflow(storage, { ...baseInput, ...overrides });

describe('agent workflows storage', () => {
  it('loads an empty list for missing or malformed storage and drops invalid entries', async () => {
    const storage = createStorage();
    await expect(loadAgentWorkflows(storage)).resolves.toStrictEqual([]);

    storage.values.set(AGENT_WORKFLOWS_STORAGE_KEY, { wrong: true });
    await expect(loadAgentWorkflows(storage)).resolves.toStrictEqual([]);

    const valid: AgentWorkflow = {
      ...baseInput,
      createdAt: 1,
      id: 'keep-me',
      updatedAt: 1,
    };
    const expected: AgentWorkflow = { ...valid, approvedScriptHash: undefined };
    storage.values.set(AGENT_WORKFLOWS_STORAGE_KEY, [
      valid,
      { id: '', name: 'bad' },
      { ...valid, id: 'script-too-long', script: 's'.repeat(MAX_WORKFLOW_SCRIPT_LENGTH + 1) },
    ]);
    await expect(loadAgentWorkflows(storage)).resolves.toStrictEqual([expected]);
  });

  it('addAgentWorkflow assigns id and timestamps', async () => {
    const storage = createStorage();
    const saved = await baseCreate(storage, {
      description: 'A test',
      name: 'My Workflow',
    });

    expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // eslint-disable-next-line vitest/prefer-expect-type-of -- Runtime checks, not compile-time type assertions.
    expect(typeof saved.createdAt).toBe('number');
    // eslint-disable-next-line vitest/prefer-expect-type-of -- Runtime checks, not compile-time type assertions.
    expect(typeof saved.updatedAt).toBe('number');
  });

  it('addAgentWorkflow preserves input fields', async () => {
    const storage = createStorage();
    const saved = await baseCreate(storage, {
      description: 'A test',
      name: 'My Workflow',
    });

    expect(saved.name).toBe('My Workflow');
    expect(saved.description).toBe('A test');
    expect(saved.approvedScriptHash).toBeUndefined();
  });

  it('throws AgentWorkflowStoreFullError at the cap', async () => {
    const storage = createStorage();
    const full: AgentWorkflow[] = Array.from({ length: MAX_WORKFLOW_COUNT }, (_unused, index) => ({
      ...baseInput,
      createdAt: index,
      id: `id-${index}`,
      updatedAt: index,
    }));
    await saveAgentWorkflows(storage, full);

    await expect(baseCreate(storage)).rejects.toBeInstanceOf(AgentWorkflowStoreFullError);
    await expect(baseCreate(storage)).rejects.toMatchObject({
      name: 'AgentWorkflowStoreFullError',
    });
  });

  it('round-trips CRUD operations', async () => {
    const storage = createStorage();
    const first = await baseCreate(storage, { name: 'First' });
    const second = await baseCreate(storage, { name: 'Second' });

    const all = await loadAgentWorkflows(storage);
    expect(all).toHaveLength(2);

    await deleteAgentWorkflow(storage, first.id);
    const afterDelete = await loadAgentWorkflows(storage);
    expect(afterDelete).toStrictEqual([second]);
  });

  it('updateAgentWorkflow replaces by id and updates timestamps', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { name: 'Old' });
    const originalUpdatedAt = created.updatedAt;

    // Small delay to ensure timestamp changes.
    // eslint-disable-next-line promise/avoid-new -- Intentional delay for test timestamp ordering.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 5);
    });

    const updated = await updateAgentWorkflow(storage, created.id, { name: 'New' });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('New');
    expect(updated.updatedAt).toBeGreaterThan(originalUpdatedAt);

    const loaded = await loadAgentWorkflows(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe('New');
  });

  it('updateAgentWorkflow clears approval when script changes', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { script: 'return 1;' });

    // Manually set approval hash for the test.
    const approved: AgentWorkflow = { ...created, approvedScriptHash: 'abc123' };
    await saveAgentWorkflows(storage, [approved]);

    // Update with a new script — approval must be cleared.
    const updated = await updateAgentWorkflow(storage, created.id, { script: 'return 2;' });
    expect(updated.approvedScriptHash).toBeUndefined();

    const loaded = await loadAgentWorkflows(storage);
    expect(loaded[0]?.approvedScriptHash).toBeUndefined();
  });

  it('updateAgentWorkflow keeps approval when script does not change', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { script: 'return 1;' });

    const approved: AgentWorkflow = { ...created, approvedScriptHash: 'abc123' };
    await saveAgentWorkflows(storage, [approved]);

    const updated = await updateAgentWorkflow(storage, created.id, { name: 'Renamed' });
    expect(updated.approvedScriptHash).toBe('abc123');

    const loaded = await loadAgentWorkflows(storage);
    expect(loaded[0]?.approvedScriptHash).toBe('abc123');
  });

  it('updateAgentWorkflow persists explicitly provided hash when script does not change', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { script: 'return 1;' });

    const approved: AgentWorkflow = { ...created, approvedScriptHash: 'old-hash' };
    await saveAgentWorkflows(storage, [approved]);

    // Caller explicitly provides a new approval hash while keeping the same script.
    const updated = await updateAgentWorkflow(storage, created.id, {
      approvedScriptHash: 'new-hash',
      name: 'Renamed',
    });
    expect(updated.approvedScriptHash).toBe('new-hash');

    const loaded = await loadAgentWorkflows(storage);
    expect(loaded[0]?.approvedScriptHash).toBe('new-hash');
  });

  it('updateAgentWorkflow uses supplied hash when script changes and hash is provided', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { script: 'return 1;' });

    // Script changes, but the caller supplies the hash for the new script.
    const updated = await updateAgentWorkflow(storage, created.id, {
      approvedScriptHash: 'hash-for-v2',
      script: 'return 2;',
    });
    expect(updated.approvedScriptHash).toBe('hash-for-v2');

    const loaded = await loadAgentWorkflows(storage);
    expect(loaded[0]?.approvedScriptHash).toBe('hash-for-v2');
  });

  it('updateAgentWorkflow clears approval when script changes and no hash is supplied', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { script: 'return 1;' });

    const approved: AgentWorkflow = { ...created, approvedScriptHash: 'abc123' };
    await saveAgentWorkflows(storage, [approved]);

    // Script changes without a new hash — approval must be cleared.
    const updated = await updateAgentWorkflow(storage, created.id, { script: 'return 2;' });
    expect(updated.approvedScriptHash).toBeUndefined();

    const loaded = await loadAgentWorkflows(storage);
    expect(loaded[0]?.approvedScriptHash).toBeUndefined();
  });

  it('updateAgentWorkflow throws when the id does not exist', async () => {
    const storage = createStorage();
    await expect(updateAgentWorkflow(storage, 'nonexistent', { name: 'Renamed' })).rejects.toThrow(
      'Workflow not found.'
    );
  });

  it('round-trips pending workflow drafts', async () => {
    const storage = createStorage();

    const draft: PendingAgentWorkflowDraft = {
      createdAt: 99,
      description: 'Draft desc',
      name: 'Draft',
      pathPrefix: '/test',
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      startUrl: 'https://example.com/start',
      workflowId: 'existing-id',
    };
    await savePendingWorkflowDraft(storage, draft);
    await expect(loadPendingWorkflowDraft(storage)).resolves.toStrictEqual(draft);

    const replacement: PendingAgentWorkflowDraft = {
      createdAt: 100,
      description: 'Next',
      name: 'Next',
      scopeOrigin: 'https://example.com/next',
      script: 'return 2;',
    };
    await savePendingWorkflowDraft(storage, replacement);
    await expect(loadPendingWorkflowDraft(storage)).resolves.toStrictEqual(replacement);

    await clearPendingWorkflowDraft(storage);
    await expect(loadPendingWorkflowDraft(storage)).resolves.toBeUndefined();
  });

  it('round-trips empty-string sentinel for clear intent', async () => {
    const storage = createStorage();

    // Save a draft with '' pathPrefix/startUrl — the clear sentinel.
    const draft: PendingAgentWorkflowDraft = {
      createdAt: 200,
      description: 'Clear fields',
      name: 'Cleared',
      pathPrefix: '',
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      startUrl: '',
      workflowId: 'wf-update',
    };
    await savePendingWorkflowDraft(storage, draft);

    const loaded = await loadPendingWorkflowDraft(storage);
    expect(loaded).toBeDefined();
    // Empty string is the clear sentinel — must survive the round-trip.
    expect(loaded?.pathPrefix).toBe('');
    expect(loaded?.startUrl).toBe('');
  });

  it('converts legacy null sentinel to empty string on load', async () => {
    const storage = createStorage();

    // Write a stored draft with null pathPrefix/startUrl (legacy format).
    storage.values.set(PENDING_WORKFLOW_SAVE_STORAGE_KEY, {
      createdAt: 200,
      description: 'Clear fields',
      name: 'Cleared',
      pathPrefix: null,
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      startUrl: null,
      workflowId: 'wf-update',
    });

    const loaded = await loadPendingWorkflowDraft(storage);
    expect(loaded).toBeDefined();
    // Legacy null must be converted to '' — never expose null to the card.
    expect(loaded?.pathPrefix).toBe('');
    expect(loaded?.startUrl).toBe('');
  });

  it('updateAgentWorkflow clears pathPrefix when value is undefined via Object.hasOwn', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, {
      name: 'With Path',
      pathPrefix: '/test',
    });
    expect(created.pathPrefix).toBe('/test');

    // Passing pathPrefix explicitly as undefined must clear it.
    const updated = await updateAgentWorkflow(storage, created.id, {
      name: 'Cleared',
      pathPrefix: undefined,
    });
    expect(updated.pathPrefix).toBeUndefined();

    const loaded = await loadAgentWorkflows(storage);
    expect(loaded[0]?.pathPrefix).toBeUndefined();
  });

  it('updateAgentWorkflow clears startUrl when value is undefined via Object.hasOwn', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, {
      name: 'With Start',
      startUrl: 'https://example.com/start',
    });
    expect(created.startUrl).toBe('https://example.com/start');

    // Passing startUrl explicitly as undefined must clear it.
    const updated = await updateAgentWorkflow(storage, created.id, {
      name: 'Cleared',
      startUrl: undefined,
    });
    expect(updated.startUrl).toBeUndefined();

    const loaded = await loadAgentWorkflows(storage);
    expect(loaded[0]?.startUrl).toBeUndefined();
  });

  it('updateAgentWorkflow keeps existing pathPrefix when key is absent', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, {
      name: 'With Path',
      pathPrefix: '/test',
    });
    expect(created.pathPrefix).toBe('/test');

    // When pathPrefix is not in the updates object, keep existing.
    const updated = await updateAgentWorkflow(storage, created.id, {
      name: 'Renamed',
    });
    expect(updated.pathPrefix).toBe('/test');
  });

  it('returns undefined and clears an invalid pending draft', async () => {
    const storage = createStorage();
    storage.values.set(PENDING_WORKFLOW_SAVE_STORAGE_KEY, { bad: true });

    await expect(loadPendingWorkflowDraft(storage)).resolves.toBeUndefined();
    expect(storage.values.has(PENDING_WORKFLOW_SAVE_STORAGE_KEY)).toBe(false);
  });

  it('loads the default settings record when nothing is stored', async () => {
    const storage = createStorage();
    const settings = await loadWorkflowSettings(storage);
    expect(settings).toStrictEqual(DEFAULT_WORKFLOW_SETTINGS);
  });

  it('upgrades an old record with new fields defaulted to false', async () => {
    const storage = createStorage();
    storage.values.set(WORKFLOW_SETTINGS_STORAGE_KEY, { allowWorkflowsInSafeMode: true });
    const settings = await loadWorkflowSettings(storage);
    expect(settings).toStrictEqual({
      allowWorkflowsInSafeMode: true,
      autoApproveWorkflowChanges: false,
      autoApproveWorkflowRuns: false,
    });
  });

  it('returns the default record for malformed settings', async () => {
    const storage = createStorage();
    storage.values.set(WORKFLOW_SETTINGS_STORAGE_KEY, 'not-an-object');
    await expect(loadWorkflowSettings(storage)).resolves.toStrictEqual(DEFAULT_WORKFLOW_SETTINGS);

    storage.values.set(WORKFLOW_SETTINGS_STORAGE_KEY, { allowWorkflowsInSafeMode: 'yes' });
    await expect(loadWorkflowSettings(storage)).resolves.toStrictEqual(DEFAULT_WORKFLOW_SETTINGS);
  });

  it('round-trips all three settings flags', async () => {
    const storage = createStorage();
    const settings: AgentWorkflowSettings = {
      allowWorkflowsInSafeMode: true,
      autoApproveWorkflowChanges: true,
      autoApproveWorkflowRuns: true,
    };
    await saveWorkflowSettings(storage, settings);
    await expect(loadWorkflowSettings(storage)).resolves.toStrictEqual(settings);

    await saveWorkflowSettings(storage, { ...DEFAULT_WORKFLOW_SETTINGS });
    const reverted = await loadWorkflowSettings(storage);
    expect(reverted).toStrictEqual(DEFAULT_WORKFLOW_SETTINGS);
  });
});

describe('workflow params storage', () => {
  const params = [
    {
      description: 'City or airport to fly to',
      example: 'SFO',
      name: 'destination',
      required: true,
    },
    { description: 'Cabin class', name: 'cabin' },
  ];

  it('persists params through create and load', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { params });

    expect(created.params).toStrictEqual(params);
    const loaded = await loadAgentWorkflows(storage);
    expect(loaded[0]?.params).toStrictEqual(params);
  });

  it('omits the params field when the list is empty', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { params: [] });
    expect(created.params).toBeUndefined();
  });

  it('replaces params on update and clears them with an empty array', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { params });

    const replaced = await updateAgentWorkflow(storage, created.id, {
      params: [{ description: 'Only one', name: 'only' }],
    });
    expect(replaced.params).toStrictEqual([{ description: 'Only one', name: 'only' }]);

    const cleared = await updateAgentWorkflow(storage, created.id, { params: [] });
    expect(cleared.params).toBeUndefined();
  });

  it('keeps existing params when the update does not mention them', async () => {
    const storage = createStorage();
    const created = await baseCreate(storage, { params });
    const updated = await updateAgentWorkflow(storage, created.id, { name: 'Renamed' });
    expect(updated.params).toStrictEqual(params);
  });
});
