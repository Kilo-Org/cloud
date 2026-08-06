import { z } from 'zod';
import { sanitizeTabContextText } from './tab-context-sanitize';

export const MAX_WORKFLOW_COUNT = 100;
export const MAX_WORKFLOW_SCRIPT_LENGTH = 32_000;
export const MAX_WORKFLOW_NAME_LENGTH = 80;
export const MAX_WORKFLOW_DESCRIPTION_LENGTH = 300;
export const MAX_WORKFLOW_PARAM_COUNT = 10;
export const MAX_WORKFLOW_PARAM_NAME_LENGTH = 40;
export const MAX_WORKFLOW_PARAM_DESCRIPTION_LENGTH = 150;
export const MAX_WORKFLOW_PARAM_EXAMPLE_LENGTH = 120;
export const MAX_WORKFLOW_PAGES_PER_RUN = 20;
export const MAX_WORKFLOW_STATE_LENGTH = 16_000;
export const WORKFLOW_INDEX_ENTRY_COUNT = 20;
export const WORKFLOW_SEARCH_RESULT_COUNT = 10;
export const WORKFLOW_PAGE_EVAL_TIMEOUT_MS = 30_000;
export const WORKFLOW_NAVIGATION_TIMEOUT_MS = 30_000;

const WORKFLOW_INDEX_PREVIEW_LENGTH = 80;

export interface AgentWorkflowParam {
  name: string;
  description: string;
  example?: string | undefined;
  required?: boolean | undefined;
}

export interface AgentWorkflow {
  id: string;
  name: string;
  description: string;
  scopeOrigin: string;
  pathPrefix?: string | undefined;
  startUrl?: string | undefined;
  params?: AgentWorkflowParam[] | undefined;
  script: string;
  approvedScriptHash?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export type AgentWorkflowInput = Omit<
  AgentWorkflow,
  'id' | 'createdAt' | 'updatedAt' | 'approvedScriptHash'
> & {
  approvedScriptHash?: string | undefined;
};

export interface PendingAgentWorkflowDraft {
  workflowId?: string | undefined;
  name: string;
  description: string;
  scopeOrigin: string;
  pathPrefix?: string | null | undefined;
  startUrl?: string | null | undefined;
  params?: AgentWorkflowParam[] | undefined;
  script: string;
  createdAt: number;
}

export interface AgentWorkflowSettings {
  allowWorkflowsInSafeMode: boolean;
}

export const agentWorkflowParamSchema = z
  .object({
    description: z.string().max(MAX_WORKFLOW_PARAM_DESCRIPTION_LENGTH),
    example: z.string().max(MAX_WORKFLOW_PARAM_EXAMPLE_LENGTH).optional(),
    name: z.string().min(1).max(MAX_WORKFLOW_PARAM_NAME_LENGTH),
    required: z.boolean().optional(),
  })
  .strip();

const workflowParamsSchema = z.array(agentWorkflowParamSchema).max(MAX_WORKFLOW_PARAM_COUNT);

export const agentWorkflowSchema = z
  .object({
    approvedScriptHash: z.string().optional(),
    createdAt: z.number(),
    description: z.string().max(MAX_WORKFLOW_DESCRIPTION_LENGTH),
    id: z.string().min(1),
    name: z.string().max(MAX_WORKFLOW_NAME_LENGTH),
    params: workflowParamsSchema.optional(),
    pathPrefix: z.string().optional(),
    scopeOrigin: z.string(),
    script: z.string().max(MAX_WORKFLOW_SCRIPT_LENGTH),
    startUrl: z.string().optional(),
    updatedAt: z.number(),
  })
  .strip();

export const agentWorkflowInputSchema = z
  .object({
    approvedScriptHash: z.string().optional(),
    description: z.string().max(MAX_WORKFLOW_DESCRIPTION_LENGTH),
    name: z.string().max(MAX_WORKFLOW_NAME_LENGTH),
    params: workflowParamsSchema.optional(),
    pathPrefix: z.string().optional(),
    scopeOrigin: z.string(),
    script: z.string().max(MAX_WORKFLOW_SCRIPT_LENGTH),
    startUrl: z.string().optional(),
  })
  .strip();

export const storedAgentWorkflowsSchema = z.array(z.unknown());

export const pendingAgentWorkflowDraftSchema = z
  .object({
    createdAt: z.number(),
    description: z.string().max(MAX_WORKFLOW_DESCRIPTION_LENGTH),
    name: z.string().max(MAX_WORKFLOW_NAME_LENGTH),
    params: workflowParamsSchema.optional(),
    pathPrefix: z.string().nullable().optional(),
    scopeOrigin: z.string(),
    script: z.string().max(MAX_WORKFLOW_SCRIPT_LENGTH),
    startUrl: z.string().nullable().optional(),
    workflowId: z.string().optional(),
  })
  .strip();

export const agentWorkflowSettingsSchema = z
  .object({
    allowWorkflowsInSafeMode: z.boolean(),
  })
  .strip();

/**
 * Compute the SHA-256 hex digest of a workflow script.
 * Used to detect script changes and invalidate approvals.
 */
export const hashWorkflowScript = async (script: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(script);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashBytes = [...new Uint8Array(hashBuffer)];
  return hashBytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Check whether a URL falls within a workflow's scope.
 * Requires origin equality. If pathPrefix is set, requires pathname.startsWith(pathPrefix).
 * Plain startsWith semantics: `/wish` matches `/wishlist`.
 */
export const matchesWorkflowScope = (
  workflow: Pick<AgentWorkflow, 'scopeOrigin' | 'pathPrefix'>,
  url: string
): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== workflow.scopeOrigin) {
      return false;
    }

    if (workflow.pathPrefix !== undefined && workflow.pathPrefix !== '') {
      return parsed.pathname.startsWith(workflow.pathPrefix);
    }

    return true;
  } catch {
    return false;
  }
};

const collapseWhitespace = (value: string): string => value.trim().replaceAll(/\s+/g, ' ');

const singleLinePreview = (value: string, maxLength: number): string => {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return collapsed.slice(0, maxLength);
};

const sortByUpdatedAtDesc = <TItem extends { updatedAt: number }>(
  items: readonly TItem[]
): TItem[] => [...items].toSorted((left, right) => right.updatedAt - left.updatedAt);

const formatWorkflowScope = (workflow: Pick<AgentWorkflow, 'scopeOrigin' | 'pathPrefix'>): string =>
  workflow.scopeOrigin + (workflow.pathPrefix ?? '');

/**
 * Search workflows scoped to currentUrl, filtered by an optional query.
 * Case-insensitive substring match on name, description, scopeOrigin, pathPrefix.
 * Capped at WORKFLOW_SEARCH_RESULT_COUNT.
 */
export const searchAgentWorkflows = (
  workflows: readonly AgentWorkflow[],
  currentUrl: string,
  query?: string
): AgentWorkflow[] => {
  const inScope = workflows.filter(workflow => matchesWorkflowScope(workflow, currentUrl));
  const sorted = sortByUpdatedAtDesc(inScope);

  const trimmedQuery = (query ?? '').trim();
  if (trimmedQuery.length === 0) {
    return sorted.slice(0, WORKFLOW_SEARCH_RESULT_COUNT);
  }

  const lowerQuery = trimmedQuery.toLowerCase();
  const matches = sorted.filter(workflow => {
    const corpus = [
      workflow.name,
      workflow.description,
      workflow.scopeOrigin,
      workflow.pathPrefix ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return corpus.includes(lowerQuery);
  });

  return matches.slice(0, WORKFLOW_SEARCH_RESULT_COUNT);
};

/**
 * Format a system-environment index of workflows scoped to currentUrl.
 * Mirrors formatAgentMemoryIndex: opening tag, one line per entry sorted by updatedAt desc,
 * a remaining-count line when entries were cut, closing tag.
 * Returns undefined when no workflow matches.
 */
export const formatAgentWorkflowIndex = (
  workflows: readonly AgentWorkflow[],
  currentUrl: string
): string | undefined => {
  const inScope = workflows.filter(workflow => matchesWorkflowScope(workflow, currentUrl));
  if (inScope.length === 0) {
    return undefined;
  }

  const newest = sortByUpdatedAtDesc(inScope).slice(0, WORKFLOW_INDEX_ENTRY_COUNT);
  const lines = newest.map(workflow => {
    const preview = sanitizeTabContextText(
      singleLinePreview(workflow.description || workflow.name, WORKFLOW_INDEX_PREVIEW_LENGTH)
    );
    const scope = formatWorkflowScope(workflow);
    const params = workflow.params ?? [];
    const paramsSuffix =
      params.length === 0
        ? ''
        : ` (inputs: ${params.map(param => sanitizeTabContextText(param.name)).join(', ')})`;

    return `- [${workflow.id}] ${sanitizeTabContextText(workflow.name)} — ${preview} (${scope})${paramsSuffix}`;
  });

  const remaining = inScope.length - WORKFLOW_INDEX_ENTRY_COUNT;
  if (remaining > 0) {
    lines.push(`(${remaining} more workflows — use search_workflows to find them.)`);
  }

  return `<workflows count="${inScope.length}">\n${lines.join('\n')}\n</workflows>`;
};

/**
 * List declared required params that the run input does not provide.
 */
export const findMissingRequiredParams = (
  workflow: Pick<AgentWorkflow, 'params'>,
  input: Record<string, unknown> | undefined
): AgentWorkflowParam[] =>
  (workflow.params ?? []).filter(
    param => param.required === true && (input === undefined || input[param.name] === undefined)
  );

/**
 * Build an actionable error message for missing required params.
 * Names each missing param with its description and example so the caller
 * (an agent or the run form) can supply values without reading the script.
 */
export const formatMissingParamsError = (missing: readonly AgentWorkflowParam[]): string => {
  const details = missing
    .map(param => {
      const example = param.example === undefined ? '' : ` (e.g. ${JSON.stringify(param.example)})`;
      return `"${param.name}" — ${param.description}${example}`;
    })
    .join('; ');
  const exampleInput = JSON.stringify(
    Object.fromEntries(missing.map(param => [param.name, param.example ?? '<value>']))
  );

  return `Missing required input: ${details}. Call run_workflow again with input: ${exampleInput}.`;
};

/**
 * Check whether a workflow's current script matches the approved hash.
 * Returns false when approvedScriptHash is absent, not just when it differs.
 */
export const isWorkflowApproved = async (
  workflow: Pick<AgentWorkflow, 'script' | 'approvedScriptHash'>
): Promise<boolean> => {
  if (workflow.approvedScriptHash === undefined) {
    return false;
  }
  const currentHash = await hashWorkflowScript(workflow.script);
  return currentHash === workflow.approvedScriptHash;
};
