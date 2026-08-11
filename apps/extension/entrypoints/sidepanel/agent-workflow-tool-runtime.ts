/* eslint-disable max-lines */
import { z } from 'zod';
import type { WorkflowToolCallEvent } from '@/src/shared/agent-conversation';
import type { EvalTabResult } from '@/src/shared/tab-debugger';
import {
  MAX_WORKFLOW_COUNT,
  MAX_WORKFLOW_NAME_LENGTH,
  MAX_WORKFLOW_SCRIPT_LENGTH,
  agentWorkflowParamSchema,
  MAX_WORKFLOW_PARAM_COUNT,
  searchAgentWorkflows,
  matchesWorkflowScope,
} from '@/src/shared/agent-workflows';
import {
  deleteAgentWorkflow,
  loadAgentWorkflows,
  loadWorkflowSettings,
} from '@/src/shared/agent-workflows-storage';
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
  params: z.array(agentWorkflowParamSchema).max(MAX_WORKFLOW_PARAM_COUNT).optional(),
  pathPrefix: z.string().optional(),
  scopeOrigin: z.string(),
  // Optional so an update (workflowId set) can keep the stored script.
  script: z.string().max(MAX_WORKFLOW_SCRIPT_LENGTH).optional(),
  startUrl: z.string().optional(),
  // A model often sends workflowId: "" for a create; a blank id means "no id", so coerce it to undefined instead of failing the update lookup.
  workflowId: z
    .string()
    .optional()
    .transform(value => (value === undefined || value.trim() === '' ? undefined : value)),
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

// ---------- run guidance ----------

// The runs toggle is a permission the model reads through the save result's nextStep.
// The setting is read when the save completes, so a change during a pending card is reflected.
// It is never a runtime refusal. The exact strings are pinned by the runtime tests.
const NEXT_STEP_RUNS_AUTO_APPROVED =
  'Auto-approve workflow runs is on. Verify with run_workflow dryRun: true when the script clicks or fills, then start the real run yourself with run_workflow.';
const NEXT_STEP_RUNS_ASK_USER =
  'Verify with run_workflow dryRun: true, then ask the user to start the first real run from Workflows in settings.';

// ---------- helpers ----------

// Zod's generic "Invalid input" gives a model nothing to act on for the one field it most often garbles. Field-specific guidance replaces it.
const ARGS_FIELD_GUIDANCE: Record<string, string> = {
  script:
    'script must be a non-empty string: the workflow function body (or a full async function) using the page.* helpers',
};

/**
 * Format a zod failure into a field-level message the model can act on.
 */
const formatArgsError = (toolName: string, error: z.ZodError): string => {
  const details = error.issues
    .slice(0, 5)
    .map(issue => {
      const path = issue.path.join('.') || '(root)';
      const guidance = ARGS_FIELD_GUIDANCE[path];
      return `${path}: ${guidance ?? issue.message}`;
    })
    .join('; ');

  return `Invalid arguments for ${toolName} — ${details}.`;
};

/**
 * Resolve a relative startUrl (e.g. "/" or "/travel/flights") against the
 * workflow scope. Models reasonably pass a path; accept it instead of failing.
 * Returns the input unchanged when it is already absolute or unresolvable.
 */
export const resolveWorkflowStartUrl = (
  startUrl: string | undefined,
  scopeOrigin: string
): string | undefined => {
  if (startUrl === undefined || URL.canParse(startUrl)) {
    return startUrl;
  }
  if (!startUrl.startsWith('/')) {
    return startUrl;
  }
  try {
    return new URL(startUrl, scopeOrigin).toString();
  } catch {
    return startUrl;
  }
};

/**
 * Explain an empty search without inviting the same call again.
 * A query already covers every site, so a query that matched nothing must not
 * suggest searching again with a query.
 */
export const formatEmptySearchMessage = (savedCount: number, query: string | undefined): string => {
  if (savedCount === 0) {
    return 'No workflows saved yet. Use save_workflow to create one.';
  }

  const trimmedQuery = (query ?? '').trim();
  if (trimmedQuery.length > 0) {
    return `No saved workflow matches "${trimmedQuery}". This search already covered every site, and ${String(savedCount)} workflow(s) are saved. Call search_workflows with no query to list the ones for this site, ask the user which workflow they mean, or save a new one.`;
  }

  return `No workflows for this site. ${String(savedCount)} workflow(s) are saved for other sites — call search_workflows with a query to find them.`;
};

const validateWorkflowInput = (
  args: Omit<z.infer<typeof saveWorkflowArgsSchema>, 'script'> & { readonly script: string }
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

  if (args.params !== undefined) {
    const names = args.params.map(param => param.name);
    if (new Set(names).size !== names.length) {
      return 'params must not contain duplicate names.';
    }
  }

  if (args.startUrl !== undefined) {
    if (!URL.canParse(args.startUrl)) {
      return `startUrl must be an absolute URL inside the scope, e.g. "${args.scopeOrigin}/path", or a path starting with "/". Received: ${args.startUrl}`;
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
 * `extra` is merged into the approved value only, so the rejected, aborted, and failed
 * shapes stay byte-identical.
 */
const approvalOutcomeToToolResult = (
  outcome: ApprovalOutcome,
  idKey: 'workflowId' | 'memoryId',
  extra: Record<string, unknown> = {}
): EvalTabResult => {
  if (outcome.status === 'approved') {
    return { ok: true, value: { [idKey]: outcome.savedId, saved: true, ...extra } };
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
 * The workflow name rides along so the transcript and the model can say
 * which workflow produced the result or the failure.
 */
const runResultToToolResult = (
  result: WorkflowRunResult,
  dryRun: boolean,
  workflowName: string
): EvalTabResult => {
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
        workflowName,
        ...extra,
      },
    };
  }

  const withPage =
    result.pageUrl === undefined ? result.error : `${result.error} (page: ${result.pageUrl})`;

  return {
    error: `Workflow "${workflowName}" failed: ${withPage}`,
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
    return { error: formatArgsError('search_workflows', parsed.error), ok: false };
  }

  const workflows = await loadAgentWorkflows(ctx.storage);
  const results = searchAgentWorkflows(workflows, ctx.selectedTabUrl, parsed.data.query);

  if (results.length === 0) {
    return {
      ok: true,
      value: {
        message: formatEmptySearchMessage(workflows.length, parsed.data.query),
        results: [],
      },
    };
  }

  return {
    ok: true,
    value: {
      results: results.map(item => ({
        description: item.description,
        id: item.id,
        inScope: matchesWorkflowScope(item, ctx.selectedTabUrl),
        name: item.name,
        params: item.params ?? [],
        pathPrefix: item.pathPrefix,
        scopeOrigin: item.scopeOrigin,
        startUrl: item.startUrl,
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
    return { error: formatArgsError('get_workflow', parsed.error), ok: false };
  }

  const workflows = await loadAgentWorkflows(ctx.storage);
  const workflow = workflows.find(item => item.id === parsed.data.workflowId);

  if (workflow === undefined) {
    return {
      error: 'Workflow not found. Use search_workflows to list saved workflows and their ids.',
      ok: false,
    };
  }

  return { ok: true, value: workflow };
};

const executeSaveWorkflow = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  const rawParsed = saveWorkflowArgsSchema.safeParse(toolCall.arguments);
  if (!rawParsed.success) {
    return { error: formatArgsError('save_workflow', rawParsed.error), ok: false };
  }

  const resolvedStartUrl = resolveWorkflowStartUrl(
    rawParsed.data.startUrl,
    rawParsed.data.scopeOrigin
  );

  const workflows = await loadAgentWorkflows(ctx.storage);
  const existing =
    rawParsed.data.workflowId === undefined
      ? undefined
      : workflows.find(item => item.id === rawParsed.data.workflowId);

  // For a Create (no workflowId), check store fullness first.
  if (rawParsed.data.workflowId === undefined) {
    if (workflows.length >= MAX_WORKFLOW_COUNT) {
      return {
        ok: true,
        value: {
          reason: 'Workflow store is full. Delete a workflow first.',
          saved: false,
        },
      };
    }
    if (rawParsed.data.script === undefined) {
      return {
        error:
          'save_workflow requires script when creating a workflow: pass the workflow function body (or a full async function) as a string.',
        ok: false,
      };
    }
  } else if (existing === undefined) {
    // For an Update, verify the workflow exists.
    return {
      error:
        'Workflow not found — the workflowId does not match any saved workflow. Use search_workflows to find it, or omit workflowId to create a new workflow.',
      ok: false,
    };
  }

  // An update may omit script to keep the stored version.
  const parsed = {
    data: {
      ...rawParsed.data,
      script: rawParsed.data.script ?? existing?.script ?? '',
      ...(resolvedStartUrl === undefined ? {} : { startUrl: resolvedStartUrl }),
    },
  };

  const validationError = validateWorkflowInput(parsed.data);
  if (validationError !== undefined) {
    return { error: validationError, ok: false };
  }

  const { name, description, scopeOrigin, script, pathPrefix, startUrl, workflowId, params } =
    parsed.data;

  const draft = {
    createdAt: Date.now(),
    description,
    name,
    scopeOrigin,
    script,
    ...(workflowId === undefined
      ? {
          ...(params === undefined || params.length === 0 ? {} : { params }),
          ...(pathPrefix === undefined ? {} : { pathPrefix }),
          ...(startUrl === undefined ? {} : { startUrl }),
        }
      : {
          // Update: always include so the card and storage can carry a clear intent.
          // Empty string is the "cleared" sentinel — it survives JSON serialization
          // (unlike undefined) but is never a valid real value. Params use the
          // Empty array the same way.
          params: params ?? [],
          pathPrefix: pathPrefix ?? '',
          startUrl: startUrl ?? '',
          workflowId,
        }),
  };

  // The runs toggle is a permission the model reads through the save result's nextStep.
  // Request approval first, then read the setting when the save completes.
  // A change made while the card was pending is reflected in the guidance.
  const outcome = await ctx.requestApproval('workflow', draft);

  // A failed settings read still permits the save and falls back to the cautious ask-the-user guidance.
  let runsAutoApproved = false;
  if (outcome.status === 'approved') {
    try {
      const settings = await loadWorkflowSettings(ctx.storage);
      runsAutoApproved = settings.autoApproveWorkflowRuns;
    } catch {
      // The nextStep is guidance only. An unreadable setting falls back to the cautious text.
    }
  }

  const extra: Record<string, unknown> =
    outcome.status === 'approved'
      ? {
          autoApproved: outcome.autoApproved,
          nextStep: runsAutoApproved ? NEXT_STEP_RUNS_AUTO_APPROVED : NEXT_STEP_RUNS_ASK_USER,
        }
      : {};
  return approvalOutcomeToToolResult(outcome, 'workflowId', extra);
};

const executeRunWorkflow = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  // Safe mode gate.
  if (ctx.mode === 'safe' && !ctx.allowWorkflowsInSafeMode) {
    return {
      error:
        'Workflow runs are disabled in safe mode. Ask the user to enable "Allow workflows in safe mode" in settings, or to switch this conversation to dangerous mode.',
      ok: false,
    };
  }

  const parsed = runWorkflowArgsSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { error: formatArgsError('run_workflow', parsed.error), ok: false };
  }

  const { workflowId, dryRun = false, input } = parsed.data;

  const workflows = await loadAgentWorkflows(ctx.storage);
  const workflow = workflows.find(item => item.id === workflowId);

  if (workflow === undefined) {
    return {
      error: 'Workflow not found. Use search_workflows to list saved workflows and their ids.',
      ok: false,
    };
  }

  // A string/array/number input reaches the script as garbage (input.topic on "" is undefined) and weak models loop on the opaque downstream failure. Reject the shape with the exact object to send instead.
  if (
    input !== undefined &&
    (typeof input !== 'object' || input === null || Array.isArray(input))
  ) {
    const params = workflow.params ?? [];
    const example = params.length > 0 ? `{"${params[0]?.name ?? 'query'}": "<value>"}` : '{}';
    const declared =
      params.length > 0 ? params.map(param => param.name).join(', ') : 'none — omit input entirely';
    return {
      error: `run_workflow input must be a JSON object mapping declared param names to values, e.g. ${example}. Declared params: ${declared}.`,
      ok: false,
    };
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

  return runResultToToolResult(result, dryRun, workflow.name);
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
    return { error: formatArgsError('delete_workflow', parsed.error), ok: false };
  }

  const workflows = await loadAgentWorkflows(ctx.storage);
  const workflow = workflows.find(item => item.id === parsed.data.workflowId);

  if (workflow === undefined) {
    return {
      error: 'Workflow not found. Use search_workflows to list saved workflows and their ids.',
      ok: false,
    };
  }

  await deleteAgentWorkflow(ctx.storage, parsed.data.workflowId);

  // Name the deleted workflow so the transcript and the model can report the change.
  return { ok: true, value: { deleted: true, name: workflow.name, workflowId: workflow.id } };
};

const executeSaveMemory = async (
  toolCall: WorkflowToolCallEvent,
  ctx: WorkflowToolContext
): Promise<EvalTabResult> => {
  const parsed = saveMemoryArgsSchema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    return { error: formatArgsError('save_memory', parsed.error), ok: false };
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
