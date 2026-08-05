import type { z } from 'zod';
import {
  MAX_WORKFLOW_COUNT,
  agentWorkflowInputSchema,
  agentWorkflowSchema,
  pendingAgentWorkflowDraftSchema,
  storedAgentWorkflowsSchema,
  agentWorkflowSettingsSchema,
} from './agent-workflows';
import type {
  AgentWorkflow,
  AgentWorkflowInput,
  AgentWorkflowSettings,
  PendingAgentWorkflowDraft,
} from './agent-workflows';

export const AGENT_WORKFLOWS_STORAGE_KEY = 'local:kiloAgentWorkflows';
export const PENDING_WORKFLOW_SAVE_STORAGE_KEY = 'local:kiloPendingWorkflowSave';
export const WORKFLOW_SETTINGS_STORAGE_KEY = 'local:kiloWorkflowSettings';

type MaybePromise<Value> = Promise<Value> | Value;

type AgentWorkflowsStorageKey =
  | typeof AGENT_WORKFLOWS_STORAGE_KEY
  | typeof PENDING_WORKFLOW_SAVE_STORAGE_KEY
  | typeof WORKFLOW_SETTINGS_STORAGE_KEY;

export interface AgentWorkflowsStorageArea {
  getItem(key: AgentWorkflowsStorageKey): MaybePromise<unknown>;
  setItem(key: AgentWorkflowsStorageKey, value: unknown): MaybePromise<void>;
  removeItem(key: AgentWorkflowsStorageKey): MaybePromise<void>;
}

export class AgentWorkflowStoreFullError extends Error {
  constructor(message = 'Agent workflow store is full.') {
    super(message);
    this.name = 'AgentWorkflowStoreFullError';
  }
}

const toAgentWorkflow = (value: z.infer<typeof agentWorkflowSchema>): AgentWorkflow => ({
  approvedScriptHash: value.approvedScriptHash,
  createdAt: value.createdAt,
  description: value.description,
  id: value.id,
  name: value.name,
  scopeOrigin: value.scopeOrigin,
  script: value.script,
  updatedAt: value.updatedAt,
  ...(value.pathPrefix === undefined ? {} : { pathPrefix: value.pathPrefix }),
  ...(value.startUrl === undefined ? {} : { startUrl: value.startUrl }),
});

const toPendingDraft = (
  value: z.infer<typeof pendingAgentWorkflowDraftSchema>
): PendingAgentWorkflowDraft => {
  const draft: PendingAgentWorkflowDraft = {
    createdAt: value.createdAt,
    description: value.description,
    name: value.name,
    scopeOrigin: value.scopeOrigin,
    script: value.script,
  };

  // Preserve clear intent: null becomes '' (empty string sentinel) so
  // Object.hasOwn detects the key and the card never renders raw null.
  if (Object.hasOwn(value, 'pathPrefix')) {
    draft.pathPrefix = value.pathPrefix === null ? '' : value.pathPrefix;
  }
  if (Object.hasOwn(value, 'startUrl')) {
    draft.startUrl = value.startUrl === null ? '' : value.startUrl;
  }
  if (Object.hasOwn(value, 'workflowId')) {
    draft.workflowId = value.workflowId;
  }

  return draft;
};

export const normalizeAgentWorkflows = (value: unknown): AgentWorkflow[] => {
  const parsed = storedAgentWorkflowsSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  return parsed.data.flatMap(entry => {
    const workflow = agentWorkflowSchema.safeParse(entry);
    return workflow.success ? [toAgentWorkflow(workflow.data)] : [];
  });
};

export const loadAgentWorkflows = async (
  storageArea: AgentWorkflowsStorageArea
): Promise<AgentWorkflow[]> =>
  normalizeAgentWorkflows(await storageArea.getItem(AGENT_WORKFLOWS_STORAGE_KEY));

export const saveAgentWorkflows = async (
  storageArea: AgentWorkflowsStorageArea,
  workflows: readonly AgentWorkflow[]
): Promise<void> => {
  await storageArea.setItem(AGENT_WORKFLOWS_STORAGE_KEY, normalizeAgentWorkflows(workflows));
};

export const addAgentWorkflow = async (
  storageArea: AgentWorkflowsStorageArea,
  input: AgentWorkflowInput
): Promise<AgentWorkflow> => {
  const parsedInput = agentWorkflowInputSchema.parse(input);
  const workflows = await loadAgentWorkflows(storageArea);

  if (workflows.length >= MAX_WORKFLOW_COUNT) {
    throw new AgentWorkflowStoreFullError();
  }

  const now = Date.now();
  const candidate: AgentWorkflow = {
    approvedScriptHash: parsedInput.approvedScriptHash,
    createdAt: now,
    description: parsedInput.description,
    id: crypto.randomUUID(),
    name: parsedInput.name,
    scopeOrigin: parsedInput.scopeOrigin,
    script: parsedInput.script,
    updatedAt: now,
    ...(parsedInput.pathPrefix === undefined ? {} : { pathPrefix: parsedInput.pathPrefix }),
    ...(parsedInput.startUrl === undefined ? {} : { startUrl: parsedInput.startUrl }),
  };

  const workflow = toAgentWorkflow(agentWorkflowSchema.parse(candidate));
  await saveAgentWorkflows(storageArea, [...workflows, workflow]);
  return workflow;
};

export const updateAgentWorkflow = async (
  storageArea: AgentWorkflowsStorageArea,
  id: string,
  updates: Partial<AgentWorkflowInput>
): Promise<AgentWorkflow> => {
  const workflows = await loadAgentWorkflows(storageArea);
  const existing = workflows.find(workflow => workflow.id === id);
  if (existing === undefined) {
    throw new Error('Workflow not found.');
  }

  const scriptChanged = updates.script !== undefined && updates.script !== existing.script;

  const approvedScriptHash = scriptChanged
    ? (updates.approvedScriptHash ?? undefined)
    : (updates.approvedScriptHash ?? existing.approvedScriptHash);

  const pathPrefixProvided = Object.hasOwn(updates, 'pathPrefix');
  const resolvedPathPrefix = pathPrefixProvided ? updates.pathPrefix : existing.pathPrefix;
  const startUrlProvided = Object.hasOwn(updates, 'startUrl');
  const resolvedStartUrl = startUrlProvided ? updates.startUrl : existing.startUrl;

  const updated: AgentWorkflow = {
    approvedScriptHash,
    createdAt: existing.createdAt,
    description: updates.description ?? existing.description,
    id: existing.id,
    name: updates.name ?? existing.name,
    scopeOrigin: updates.scopeOrigin ?? existing.scopeOrigin,
    script: updates.script ?? existing.script,
    updatedAt: Date.now(),
    ...(resolvedPathPrefix === undefined ? {} : { pathPrefix: resolvedPathPrefix }),
    ...(resolvedStartUrl === undefined ? {} : { startUrl: resolvedStartUrl }),
  };

  const validated = toAgentWorkflow(agentWorkflowSchema.parse(updated));
  const replaced = workflows.map(workflow => (workflow.id === id ? validated : workflow));
  await saveAgentWorkflows(storageArea, replaced);
  return validated;
};

export const deleteAgentWorkflow = async (
  storageArea: AgentWorkflowsStorageArea,
  id: string
): Promise<void> => {
  const workflows = await loadAgentWorkflows(storageArea);
  await saveAgentWorkflows(
    storageArea,
    workflows.filter(workflow => workflow.id !== id)
  );
};

export const savePendingWorkflowDraft = async (
  storageArea: AgentWorkflowsStorageArea,
  draft: PendingAgentWorkflowDraft
): Promise<void> => {
  const parsed = toPendingDraft(pendingAgentWorkflowDraftSchema.parse(draft));
  await storageArea.setItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY, parsed);
};

export const loadPendingWorkflowDraft = async (
  storageArea: AgentWorkflowsStorageArea
): Promise<PendingAgentWorkflowDraft | undefined> => {
  const value = await storageArea.getItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY);
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsed = pendingAgentWorkflowDraftSchema.safeParse(value);
  if (!parsed.success) {
    await storageArea.removeItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY);
    return undefined;
  }

  return toPendingDraft(parsed.data);
};

export const clearPendingWorkflowDraft = async (
  storageArea: AgentWorkflowsStorageArea
): Promise<void> => {
  await storageArea.removeItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY);
};

export const loadWorkflowSettings = async (
  storageArea: AgentWorkflowsStorageArea
): Promise<AgentWorkflowSettings> => {
  const value = await storageArea.getItem(WORKFLOW_SETTINGS_STORAGE_KEY);
  if (value === null || value === undefined) {
    return { allowWorkflowsInSafeMode: false };
  }

  const parsed = agentWorkflowSettingsSchema.safeParse(value);
  if (!parsed.success) {
    return { allowWorkflowsInSafeMode: false };
  }

  return parsed.data;
};

export const saveWorkflowSettings = async (
  storageArea: AgentWorkflowsStorageArea,
  settings: AgentWorkflowSettings
): Promise<void> => {
  const parsed = agentWorkflowSettingsSchema.parse(settings);
  await storageArea.setItem(WORKFLOW_SETTINGS_STORAGE_KEY, parsed);
};
