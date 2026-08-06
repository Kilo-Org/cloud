/* eslint-disable max-lines -- Sequential state machine that is clearest as one cohesive unit; splitting would obscure flow. */
import { z } from 'zod';
import {
  MAX_WORKFLOW_PAGES_PER_RUN,
  MAX_WORKFLOW_STATE_LENGTH,
  findMissingRequiredParams,
  formatMissingParamsError,
  isWorkflowApproved,
  matchesWorkflowScope,
} from './agent-workflows';
import type { AgentWorkflow } from './agent-workflows';

export type WorkflowRunResult =
  | {
      ok: true;
      pagesVisited: number;
      result: unknown;
      dryRunActions?: { action: string; selector: string }[] | undefined;
    }
  | {
      ok: false;
      error: string;
      pageUrl?: string | undefined;
      dryRunActions?: { action: string; selector: string }[] | undefined;
    };

interface EvalTabOkResult {
  ok: true;
  value: unknown;
}
interface EvalTabErrResult {
  ok: false;
  error: string;
}
type EvalTabResult = EvalTabOkResult | EvalTabErrResult;

interface WorkflowRunnerDeps {
  evalInTab(tabId: number, code: string): Promise<EvalTabResult>;
  getTabUrl(tabId: number): Promise<string>;
  navigateTab(tabId: number, url: string): Promise<void>;
}

const scriptEnvelopeSchema = z.object({
  dryRunActions: z
    .array(z.object({ action: z.string(), selector: z.string() }))
    .optional()
    .default([]),
  error: z.string().optional(),
  ok: z.boolean(),
  value: z.unknown().optional(),
});

/**
 * Build the injected page code for a single workflow page eval.
 * Uses plain string CONCATENATION, never a template literal — a workflow script
 * containing a backtick or `${` would otherwise break or corrupt the composed code.
 * `state`, `dryRun`, and `input` are embedded with `JSON.stringify`.
 * `input` is re-injected on every page so scripts never lose run inputs
 * across navigations; `state` carries only what the script returns.
 */
/* eslint-disable prefer-template, max-params -- Concatenation avoids template-literal injection from untrusted workflow scripts; the page code needs all four values. */
export const buildWorkflowPageCode = (
  script: string,
  state: unknown,
  dryRun: boolean,
  input: unknown = {}
): string =>
  'const dryRun = ' +
  JSON.stringify(dryRun) +
  ';\n' +
  'const dryRunActions = [];\n' +
  'const page = {\n' +
  '  __q(selector) {\n' +
  '    const el = document.querySelector(selector);\n' +
  "    if (el === null) { throw new Error('No element matches selector: ' + selector); }\n" +
  '    return el;\n' +
  '  },\n' +
  '  click(selector) {\n' +
  '    const el = page.__q(selector);\n' +
  "    if (dryRun) { dryRunActions.push({ action: 'click', selector }); return; }\n" +
  '    el.click();\n' +
  '  },\n' +
  '  fill(selector, value) {\n' +
  '    const el = page.__q(selector);\n' +
  "    if (dryRun) { dryRunActions.push({ action: 'fill', selector }); return; }\n" +
  '    const proto = el instanceof HTMLTextAreaElement\n' +
  '      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n' +
  "    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;\n" +
  '    if (setter) { setter.call(el, value); } else { el.value = value; }\n' +
  "    el.dispatchEvent(new Event('input', { bubbles: true }));\n" +
  "    el.dispatchEvent(new Event('change', { bubbles: true }));\n" +
  '  },\n' +
  "  text(selector) { return (page.__q(selector).textContent ?? '').trim(); },\n" +
  '  textAll(selector) {\n' +
  '    return Array.from(document.querySelectorAll(selector))\n' +
  "      .map((el) => (el.textContent ?? '').trim());\n" +
  '  },\n' +
  '  attr(selector, name) { return page.__q(selector).getAttribute(name); },\n' +
  '  exists(selector) { return document.querySelector(selector) !== null; },\n' +
  '  async waitFor(selector, timeoutMs) {\n' +
  "    if (dryRun) { dryRunActions.push({ action: 'waitFor', selector }); return; }\n" +
  '    const limit = typeof timeoutMs === "number" && timeoutMs > 0 ? Math.min(timeoutMs, 25000) : 10000;\n' +
  '    const start = Date.now();\n' +
  '    while (document.querySelector(selector) === null) {\n' +
  '      if (Date.now() - start >= limit) {\n' +
  "        throw new Error('Timed out waiting for selector: ' + selector + ' (' + limit + 'ms). The element never appeared; check the selector or wait for a different one.');\n" +
  '      }\n' +
  '      await new Promise((resolve) => setTimeout(resolve, 100));\n' +
  '    }\n' +
  '  },\n' +
  '};\n' +
  'const workflow = async ({ page, state, input }) => { ' +
  script +
  ' };\n' +
  'try {\n' +
  '  const value = await workflow({ page, state: ' +
  JSON.stringify(state) +
  ', input: ' +
  JSON.stringify(input) +
  ' });\n' +
  '  return { ok: true, value, dryRunActions };\n' +
  '} catch (error) {\n' +
  '  return {\n' +
  '    ok: false,\n' +
  '    error: error instanceof Error ? error.message : String(error),\n' +
  '    dryRunActions,\n' +
  '  };\n' +
  '}';
/* eslint-enable prefer-template */

interface RunWorkflowOptions {
  dryRun?: boolean;
  input?: unknown;
  signal?: AbortSignal;
  tabId: number;
  workflow: AgentWorkflow;
}

/**
 * Conditionally include dryRunActions in a result object.
 * Only adds the field when dryRun is true.
 */
const resultWithActions = (
  base: WorkflowRunResult,
  dryRun: boolean,
  actions: { action: string; selector: string }[]
): WorkflowRunResult => {
  if (dryRun) {
    return { ...base, dryRunActions: actions };
  }
  return base;
};

const isRunStopped = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

type NavigationValidationResult =
  | { kind: 'ok'; navigateUrl: string; nextState: Record<string, unknown> }
  | { kind: 'error'; errorResult: WorkflowRunResult };

const validateNavigationState = (
  workflow: Pick<AgentWorkflow, 'scopeOrigin' | 'pathPrefix'>,
  innerValue: Record<string, unknown>,
  url: string
): NavigationValidationResult => {
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Caller ensures this is a string via typeof check.
  const navigateUrl = innerValue['navigate'] as string;
  const nextState = innerValue['state'];

  // Reject null, undefined, primitives, and arrays as navigation state.
  if (
    nextState === null ||
    nextState === undefined ||
    typeof nextState !== 'object' ||
    Array.isArray(nextState)
  ) {
    return {
      errorResult: {
        error: 'Workflow script returned an invalid value.',
        ok: false,
        pageUrl: url,
      },
      kind: 'error' as const,
    };
  }

  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Preceding checks guarantee it is a non-null, non-array object.
  const stateObject = nextState as Record<string, unknown>;

  // Serialize state and check length.
  let serializedState = '';
  try {
    serializedState = JSON.stringify(stateObject);
  } catch {
    return {
      errorResult: {
        error: 'Workflow state is not serializable.',
        ok: false,
        pageUrl: url,
      },
      kind: 'error' as const,
    };
  }

  if (serializedState.length > MAX_WORKFLOW_STATE_LENGTH) {
    return {
      errorResult: {
        error: 'Workflow state exceeds the size limit.',
        ok: false,
        pageUrl: url,
      },
      kind: 'error' as const,
    };
  }

  // Check navigation target is in scope.
  if (!matchesWorkflowScope(workflow, navigateUrl)) {
    return {
      errorResult: {
        error: 'Navigation target is outside the workflow scope.',
        ok: false,
        pageUrl: url,
      },
      kind: 'error' as const,
    };
  }

  return { kind: 'ok' as const, navigateUrl, nextState: stateObject };
};

/**
 * Run a stored workflow script across one or more pages.
 *
 * The script receives `{ page, state, input }`: page provides DOM helpers,
 * input holds the run inputs on every page, and state carries what the
 * script returns across navigations (`state.input` also mirrors input on
 * the first page for older scripts). The script must return one of:
 * - `{ done: true, result: <JSON-serializable> }` to finish
 * - `{ navigate: '<url>', state: <JSON object> }` to move to the next page
 * A thrown error fails the run with the error message and the page URL.
 *
 * Dry runs record click/fill actions instead of performing them. Navigations
 * still happen. Dry run is a convenience, not a security boundary.
 */
export const runWorkflow = async (
  deps: WorkflowRunnerDeps,
  options: RunWorkflowOptions
): Promise<WorkflowRunResult> => {
  const { workflow, tabId, input, dryRun = false, signal } = options;

  // 1. Approval gate — also applies to dry runs.
  if (!(await isWorkflowApproved(workflow))) {
    return resultWithActions({ error: 'Workflow script is not approved.', ok: false }, dryRun, []);
  }

  // 2a. Input shape gate — before any navigation.
  if (
    input !== undefined &&
    (typeof input !== 'object' || input === null || Array.isArray(input))
  ) {
    return resultWithActions(
      {
        error: 'run_workflow input must be a JSON object like { "name": "value" }.',
        ok: false,
      },
      dryRun,
      []
    );
  }

  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Preceding check guarantees a plain object or undefined.
  const normalizedInput = (input ?? {}) as Record<string, unknown>;

  // 2b. Declared-params gate — actionable message listing every missing value.
  const missingParams = findMissingRequiredParams(workflow, normalizedInput);
  if (missingParams.length > 0) {
    return resultWithActions(
      { error: formatMissingParamsError(missingParams), ok: false },
      dryRun,
      []
    );
  }

  // 2. Optional startUrl navigation.
  if (workflow.startUrl !== undefined && workflow.startUrl !== '') {
    if (!matchesWorkflowScope(workflow, workflow.startUrl)) {
      return resultWithActions(
        { error: 'Workflow startUrl is outside the workflow scope.', ok: false },
        dryRun,
        []
      );
    }
    await deps.navigateTab(tabId, workflow.startUrl);
    if (isRunStopped(signal)) {
      return resultWithActions({ error: 'Run stopped.', ok: false }, dryRun, []);
    }
  }

  // 3. Initialize before the loop. `state.input` mirrors `input` on the first
  // Page for scripts written against the old contract.
  let state: unknown = { input: normalizedInput };
  let pagesVisited = 0;
  const dryRunActions: { action: string; selector: string }[] = [];

  // Verify initial input is serializable before building injected code.
  try {
    JSON.stringify(state);
  } catch {
    return resultWithActions(
      { error: 'Workflow initial input is not serializable.', ok: false },
      dryRun,
      []
    );
  }

  // 4. Loop, at most MAX_WORKFLOW_PAGES_PER_RUN iterations.
  for (let pageIndex = 0; pageIndex < MAX_WORKFLOW_PAGES_PER_RUN; pageIndex++) {
    // A. Abort check.
    if (isRunStopped(signal)) {
      return resultWithActions({ error: 'Run stopped.', ok: false }, dryRun, dryRunActions);
    }

    // B. Scope check on current tab URL.
    // eslint-disable-next-line no-await-in-loop -- Sequential workflow execution by design.
    const url = await deps.getTabUrl(tabId);
    if (isRunStopped(signal)) {
      return resultWithActions({ error: 'Run stopped.', ok: false }, dryRun, dryRunActions);
    }
    if (!matchesWorkflowScope(workflow, url)) {
      return resultWithActions(
        { error: 'Tab is outside the workflow scope.', ok: false, pageUrl: url },
        dryRun,
        dryRunActions
      );
    }

    // C. Build the injected code.
    const code = buildWorkflowPageCode(workflow.script, state, dryRun, normalizedInput);

    // D. Eval in the tab.
    // eslint-disable-next-line no-await-in-loop — Sequential workflow execution by design.
    const evalResult = await deps.evalInTab(tabId, code);
    if (isRunStopped(signal)) {
      return resultWithActions({ error: 'Run stopped.', ok: false }, dryRun, dryRunActions);
    }
    if (!evalResult.ok) {
      return resultWithActions(
        { error: evalResult.error, ok: false, pageUrl: url },
        dryRun,
        dryRunActions
      );
    }

    // E. Increment pagesVisited and parse layer-2 envelope.
    pagesVisited++;

    const envelope = scriptEnvelopeSchema.safeParse(evalResult.value);
    if (!envelope.success) {
      return resultWithActions(
        { error: 'Workflow script returned an unparseable value.', ok: false, pageUrl: url },
        dryRun,
        dryRunActions
      );
    }

    // Accumulate dryRunActions.
    const pageActions = envelope.data.dryRunActions;
    dryRunActions.push(...pageActions);

    // Script threw an error.
    if (!envelope.data.ok) {
      return resultWithActions(
        { error: envelope.data.error ?? 'Unknown script error.', ok: false, pageUrl: url },
        dryRun,
        dryRunActions
      );
    }

    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Value passed zod validation; runtime checks follow.
    const innerValue = envelope.data.value as Record<string, unknown>;

    if (innerValue === null || innerValue === undefined || typeof innerValue !== 'object') {
      return resultWithActions(
        { error: 'Workflow script returned an invalid value.', ok: false, pageUrl: url },
        dryRun,
        dryRunActions
      );
    }

    // Success: { done: true, result: <unknown> }
    if (innerValue['done'] === true) {
      return resultWithActions(
        { ok: true, pagesVisited, result: innerValue['result'] },
        dryRun,
        dryRunActions
      );
    }

    // Navigation: { navigate: string, state: object }
    if (typeof innerValue['navigate'] === 'string' && innerValue['navigate'].length > 0) {
      const validationResult = validateNavigationState(workflow, innerValue, url);

      if (validationResult.kind === 'error') {
        return resultWithActions(validationResult.errorResult, dryRun, dryRunActions);
      }

      state = validationResult.nextState;
      // eslint-disable-next-line no-await-in-loop -- Sequential workflow execution by design.
      await deps.navigateTab(tabId, validationResult.navigateUrl);
      // eslint-disable-next-line no-continue -- Clearer than deep nesting for this state machine.
      continue;
    }

    // Anything else is invalid.
    return resultWithActions(
      { error: 'Workflow script returned an invalid value.', ok: false, pageUrl: url },
      dryRun,
      dryRunActions
    );
  }

  // 5. Loop exhausted.
  return resultWithActions(
    { error: 'Workflow exceeded the page limit.', ok: false },
    dryRun,
    dryRunActions
  );
};
