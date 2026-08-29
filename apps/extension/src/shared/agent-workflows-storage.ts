import type { z } from 'zod';
import type { ExecutionGuard } from './agent-tool-results';
import { matchesDelegatedApproval } from './agent-memories';
import type { DelegatedApprovalOrigin } from './agent-memories';
import { withPendingDraftStorageLock } from './agent-memories-storage';
import {
  DEFAULT_WORKFLOW_SETTINGS,
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
  NormalizedPendingAgentWorkflowDraft,
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
  ...(value.params === undefined || value.params.length === 0 ? {} : { params: value.params }),
  ...(value.pathPrefix === undefined ? {} : { pathPrefix: value.pathPrefix }),
  ...(value.startUrl === undefined ? {} : { startUrl: value.startUrl }),
});

const toPendingDraft = (
  value: z.infer<typeof pendingAgentWorkflowDraftSchema>
): NormalizedPendingAgentWorkflowDraft => {
  const draft: NormalizedPendingAgentWorkflowDraft = {
    createdAt: value.createdAt,
    description: value.description,
    name: value.name,
    // Old local draft records lack origin; the schema normalizes them until those records retire.
    origin: value.origin,
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
  if (value.params !== undefined) {
    draft.params = value.params;
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
  input: AgentWorkflowInput,
  // Old local storage callers omit the guard. Remove this optional form after those callers retire.
  executionGuard?: ExecutionGuard
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
    ...(parsedInput.params === undefined || parsedInput.params.length === 0
      ? {}
      : { params: parsedInput.params }),
    ...(parsedInput.pathPrefix === undefined ? {} : { pathPrefix: parsedInput.pathPrefix }),
    ...(parsedInput.startUrl === undefined ? {} : { startUrl: parsedInput.startUrl }),
  };

  const workflow = toAgentWorkflow(agentWorkflowSchema.parse(candidate));
  executionGuard?.();
  await saveAgentWorkflows(storageArea, [...workflows, workflow]);
  return workflow;
};

// eslint-disable-next-line max-params -- The optional guard preserves the existing update API.
export const updateAgentWorkflow = async (
  storageArea: AgentWorkflowsStorageArea,
  id: string,
  updates: Partial<AgentWorkflowInput>,
  // Old local storage callers omit the guard. Remove this optional form after those callers retire.
  executionGuard?: ExecutionGuard
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
  const paramsProvided = Object.hasOwn(updates, 'params');
  const resolvedParams = paramsProvided ? updates.params : existing.params;

  const updated: AgentWorkflow = {
    approvedScriptHash,
    createdAt: existing.createdAt,
    description: updates.description ?? existing.description,
    id: existing.id,
    name: updates.name ?? existing.name,
    scopeOrigin: updates.scopeOrigin ?? existing.scopeOrigin,
    script: updates.script ?? existing.script,
    updatedAt: Date.now(),
    ...(resolvedParams === undefined || resolvedParams.length === 0
      ? {}
      : { params: resolvedParams }),
    ...(resolvedPathPrefix === undefined ? {} : { pathPrefix: resolvedPathPrefix }),
    ...(resolvedStartUrl === undefined ? {} : { startUrl: resolvedStartUrl }),
  };

  const validated = toAgentWorkflow(agentWorkflowSchema.parse(updated));
  const replaced = workflows.map(workflow => (workflow.id === id ? validated : workflow));
  executionGuard?.();
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

export const savePendingWorkflowDraft = (
  storageArea: AgentWorkflowsStorageArea,
  draft: PendingAgentWorkflowDraft,
  // Old local storage callers omit the guard. Remove this optional form after those callers retire.
  executionGuard?: ExecutionGuard
): Promise<void> =>
  withPendingDraftStorageLock(PENDING_WORKFLOW_SAVE_STORAGE_KEY, async () => {
    const parsed = toPendingDraft(pendingAgentWorkflowDraftSchema.parse(draft));
    executionGuard?.();
    await storageArea.setItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY, parsed);
  });

export const loadPendingWorkflowDraft = (
  storageArea: AgentWorkflowsStorageArea
): Promise<NormalizedPendingAgentWorkflowDraft | undefined> =>
  withPendingDraftStorageLock(PENDING_WORKFLOW_SAVE_STORAGE_KEY, async () => {
    const value = await storageArea.getItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY);
    if (value === null || value === undefined) {
      return;
    }

    const parsed = pendingAgentWorkflowDraftSchema.safeParse(value);
    if (!parsed.success) {
      await storageArea.removeItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY);
      return;
    }

    return toPendingDraft(parsed.data);
  });

export const clearPendingWorkflowDraft = (
  storageArea: AgentWorkflowsStorageArea,
  expected?: DelegatedApprovalOrigin
): Promise<void> =>
  withPendingDraftStorageLock(PENDING_WORKFLOW_SAVE_STORAGE_KEY, async () => {
    if (expected !== undefined) {
      const current = pendingAgentWorkflowDraftSchema.safeParse(
        await storageArea.getItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY)
      );
      if (!current.success || !matchesDelegatedApproval(current.data.origin, expected)) {
        return;
      }
    }
    // Old local callers clear the sole draft without an invocation comparison.
    // Remove that call form only after all old local draft producers retire.
    await storageArea.removeItem(PENDING_WORKFLOW_SAVE_STORAGE_KEY);
  });

export const loadWorkflowSettings = async (
  storageArea: AgentWorkflowsStorageArea
): Promise<AgentWorkflowSettings> => {
  const value = await storageArea.getItem(WORKFLOW_SETTINGS_STORAGE_KEY);
  if (value === null || value === undefined) {
    return DEFAULT_WORKFLOW_SETTINGS;
  }

  const parsed = agentWorkflowSettingsSchema.safeParse(value);
  if (!parsed.success) {
    return DEFAULT_WORKFLOW_SETTINGS;
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
