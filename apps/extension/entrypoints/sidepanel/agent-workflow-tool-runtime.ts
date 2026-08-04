/* eslint-disable max-lines */
import { z } from 'zod';
import type { WorkflowToolCallEvent } from '@/src/shared/agent-conversation';
import type { EvalTabResult } from '@/src/shared/tab-debugger';
import {
  MAX_WORKFLOW_COUNT,
  MAX_WORKFLOW_NAME_LENGTH,
  MAX_WORKFLOW_SCRIPT_LENGTH,
  searchAgentWorkflows,
  matchesWorkflowScope,
} from '@/src/shared/agent-workflows';
import { loadAgentWorkflows, deleteAgentWorkflow } from '@/src/shared/agent-workflows-storage';
import { runWorkflow } from '@/src/shared/agent-workflow-runner';
import type { WorkflowRunResult } from '@/src/shared/agent-workflow-runner';
import type { ApprovalKind, ApprovalOutcome } from './pending-approval';

// ---------- tool context ----------

export interface WorkflowToolContext {
  readonly selectedTabUrl: string;
  readonly selectedTabId: number;
  readonly selectedTabTitle: string;
  readonly mode: 'safe' | 'dangerous';
  readonly allowWorkflowsInSafeMode: boolean;
  readonly storage: {
    getItem(key: string): unknown;
    setItem(key: string, value: unknown): void | Promise<void>;
    removeItem(key: string): void | Promise<void>;
  };
  readonly signal: AbortSignal;
  readonly requestApproval: (
    kind: ApprovalKind,
    draft: Record<string, unknown>
  ) => Promise<ApprovalOutcome>;
  readonly evalInTab: (tabId: number, code: string) => Promise<EvalTabResult>;
  readonly navigateTab: (tabId: number, url: string) => Promise<void>;
  readonly getTabUrl: (tabId: number) => Promise<string>;
}

// ---------- zod schemas ----------

const saveWorkflowArgsSchema = z.object({
  description: z.string().max(300),
  name: z.string().max(MAX_WORKFLOW_NAME_LENGTH),
  pathPrefix: z.string().optional(),
  scopeOrigin: z.string(),
  script: z.string().max(MAX_WORKFLOW_SCRIPT_LENGTH),
  startUrl: z.string().optional(),
  workflowId: z.string().optional(),
});

const searchWorkflowsArgsSchema = z.object({
  query: z.string().optional(),
});

const getWorkflowArgsSchema = z.object({
  workflowId: z.string(),
});

const runWorkflowArgsSchema = z.object({
  dryRun: z.boolean().optional(),
  input: z.unknown().optional(),
  workflowId: z.string(),
});

const deleteWorkflowArgsSchema = z.object({
  workflowId: z.string(),
});

const saveMemoryArgsSchema = z.object({
  note: z.string().max(200).optional(),
  text: z.string().max(8000),
});

// ---------- helpers ----------

const validateWorkflowInput = (
  args: z.infer<typeof saveWorkflowArgsSchema>
): string | undefined => {
  if (args.script.length === 0) {
    return 'Workflow body must not be empty.';
  }
  if (args.name.length === 0) {
    return 'Workflow name must not be empty.';
  }

  let parsedOrigin: URL | undefined = undefined;
  try {
    parsedOrigin = new URL(args.scopeOrigin);
  } catch {
    return 'scopeOrigin is not a valid URL.';
  }
  if (parsedOrigin.origin !== args.scopeOrigin) {
    return 'scopeOrigin must be a valid origin (protocol + host + port).';
  }

  if (args.pathPrefix !== undefined && !args.pathPrefix.startsWith('/')) {
    return 'pathPrefix must start with /.';
  }

  if (args.startUrl !== undefined) {
    if (!URL.canParse(args.startUrl)) {
      return 'startUrl is not a valid URL.';
    }
    if (
      !matchesWorkflowScope(
        { pathPrefix: args.pathPrefix, scopeOrigin: args.scopeOrigin },
        args.startUrl
      )
    ) {
      return 'startUrl must match the workflow scope (origin and pathPrefix, if set).';
    }
  }

  return undefined;
};

/**
 * Map an ApprovalOutcome (from requestApproval) to an EvalTabResult.
 * The mapping is identical for save_workflow and save_memory.
 * `savedId` is keyed as `workflowId` for workflow saves and `memoryId` for memory saves.
 */
const approvalOutcomeToToolResult = (
  outcome: ApprovalOutcome,
  idKey: 'workflowId' | 'memoryId'
): EvalTabResult => {
  if (outcome.status === 'approved') {
    return { ok: true, value: { [idKey]: outcome.savedId, saved: true } };
  }
  if (outcome.status === 'rejected') {
    return { ok: true, value: { reason: 'The user rejected the save.', saved: false } };
  }
  if (outcome.status === 'aborted') {
    return { error: 'Run stopped before approval.', ok: false };
  }
  // Failed to save — the draft stays in storage but the caller must know.
  return { ok: true, value: { reason: outcome.reason, saved: false } };
};

/**
 * Map a WorkflowRunResult to an EvalTabResult.
 */
const runResultToToolResult = (result: WorkflowRunResult, dryRun: boolean): EvalTabResult => {
  if (result.ok) {
    const extra: Record<string, unknown> = {};
    if (dryRun) {
      extra['dryRun'] = true;
      extra['dryRunActions'] = result.dryRunActions ?? [];
    } else if (result.dryRunActions !== undefined) {
      extra['dryRunActions'] = result.dryRunActions;
    }

    return {
      ok: true,
      value: {
        pagesVisited: result.pagesVisited,
        result: result.result,
        ...extra,
      },
    };
  }

  const error =
    result.pageUrl === undefined ? result.error : `${result.error} (page: ${result.pageUrl})`;

  return {
    error,
    ok: false,
  };
};

// ---------- tool implementations ----------

const executeSearchWorkflows = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  const parsed = searchWorkflowsArgsSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { error: 'Invalid arguments for search_workflows.', ok: false };
  }

  const workflows = await loadAgentWorkflows(ctx.storage);
  const results = searchAgentWorkflows(workflows, ctx.selectedTabUrl, parsed.data.query);

  if (results.length === 0) {
    return {
      ok: true,
      value: { message: 'No workflows for this site.', results: [] },
    };
  }

  return {
    ok: true,
    value: {
      results: results.map(item => ({
        description: item.description,
        id: item.id,
        name: item.name,
        pathPrefix: item.pathPrefix,
        scopeOrigin: item.scopeOrigin,
      })),
    },
  };
};

const executeGetWorkflow = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  const parsed = getWorkflowArgsSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { error: 'Invalid arguments for get_workflow.', ok: false };
  }

  const workflows = await loadAgentWorkflows(ctx.storage);
  const workflow = workflows.find(item => item.id === parsed.data.workflowId);

  if (workflow === undefined) {
    return { error: 'Workflow not found.', ok: false };
  }

  return { ok: true, value: workflow };
};

const executeSaveWorkflow = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  const parsed = saveWorkflowArgsSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { error: 'Invalid arguments for save_workflow.', ok: false };
  }

  const validationError = validateWorkflowInput(parsed.data);
  if (validationError !== undefined) {
    return { error: validationError, ok: false };
  }

  const { name, description, scopeOrigin, script, pathPrefix, startUrl, workflowId } = parsed.data;

  // For a Create (no workflowId), check store fullness first.
  if (workflowId === undefined) {
    const workflows = await loadAgentWorkflows(ctx.storage);
    if (workflows.length >= MAX_WORKFLOW_COUNT) {
      return {
        ok: true,
        value: {
          reason: 'Workflow store is full. Delete a workflow first.',
          saved: false,
        },
      };
    }
  } else {
    // For an Update, verify the workflow exists.
    const workflows = await loadAgentWorkflows(ctx.storage);
    if (!workflows.some(item => item.id === workflowId)) {
      return { error: 'Workflow not found.', ok: false };
    }
  }

  const draft = {
    createdAt: Date.now(),
    description,
    name,
    scopeOrigin,
    script,
    ...(workflowId === undefined
      ? {
          ...(pathPrefix === undefined ? {} : { pathPrefix }),
          ...(startUrl === undefined ? {} : { startUrl }),
        }
      : {
          // Update: always include so the card and storage can carry a clear intent.
          // Empty string is the "cleared" sentinel — it survives JSON serialization
          // (unlike undefined) but is never a valid real value.
          pathPrefix: pathPrefix ?? '',
          startUrl: startUrl ?? '',
          workflowId,
        }),
  };

  const outcome = await ctx.requestApproval('workflow', draft);
  return approvalOutcomeToToolResult(outcome, 'workflowId');
};

const executeRunWorkflow = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  // Safe mode gate.
  if (ctx.mode === 'safe' && !ctx.allowWorkflowsInSafeMode) {
    return {
      error: 'Workflows are disabled in safe mode. The user can enable them in settings.',
      ok: false,
    };
  }

  const parsed = runWorkflowArgsSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { error: 'Invalid arguments for run_workflow.', ok: false };
  }

  const { workflowId, dryRun = false, input } = parsed.data;

  const workflows = await loadAgentWorkflows(ctx.storage);
  const workflow = workflows.find(item => item.id === workflowId);

  if (workflow === undefined) {
    return { error: 'Workflow not found.', ok: false };
  }

  const result = await runWorkflow(
    // EvalInTab resolves to the same type structurally but a tsc project-reference edge case
    // Sees two different EvalTabResult declarations. Cast through Parameters to reconcile.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- required for tsc project-reference type identity
    {
      evalInTab: ctx.evalInTab,
      getTabUrl: ctx.getTabUrl,
      navigateTab: ctx.navigateTab,
    } as Parameters<typeof runWorkflow>[0],
    {
      dryRun,
      input,
      signal: ctx.signal,
      tabId: ctx.selectedTabId,
      workflow,
    }
  );

  return runResultToToolResult(result, dryRun);
};

const executeDeleteWorkflow = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  // Dangerous mode only — the safe-mode toggle only gates run_workflow, never delete.
  if (ctx.mode !== 'dangerous') {
    return {
      error: 'delete_workflow requires dangerous mode.',
      ok: false,
    };
  }

  const parsed = deleteWorkflowArgsSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { error: 'Invalid arguments for delete_workflow.', ok: false };
  }

  await deleteAgentWorkflow(ctx.storage, parsed.data.workflowId);

  return { ok: true, value: { deleted: true } };
};

const executeSaveMemory = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  const parsed = saveMemoryArgsSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { error: 'Invalid arguments for save_memory.', ok: false };
  }

  const { text, note } = parsed.data;
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return { error: 'Memory text must not be empty.', ok: false };
  }

  const draft = {
    createdAt: Date.now(),
    pageTitle: ctx.selectedTabTitle,
    pageUrl: ctx.selectedTabUrl,
    text: trimmedText,
    ...(note !== undefined && note.trim().length > 0 ? { note: note.trim() } : {}),
  };

  const outcome = await ctx.requestApproval('memory', draft);
  return approvalOutcomeToToolResult(outcome, 'memoryId');
};

// ---------- main executor ----------

export const executeWorkflowToolCall = (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  switch (toolCall.name) {
    case 'search_workflows': {
      return executeSearchWorkflows(toolCall, ctx);
    }
    case 'get_workflow': {
      return executeGetWorkflow(toolCall, ctx);
    }
    case 'save_workflow': {
      return executeSaveWorkflow(toolCall, ctx);
    }
    case 'run_workflow': {
      return executeRunWorkflow(toolCall, ctx);
    }
    case 'delete_workflow': {
      return executeDeleteWorkflow(toolCall, ctx);
    }
    case 'save_memory': {
      return executeSaveMemory(toolCall, ctx);
    }
    default: {
      return Promise.resolve({ error: `Unknown tool: ${String(toolCall.name)}`, ok: false });
    }
  }
};
