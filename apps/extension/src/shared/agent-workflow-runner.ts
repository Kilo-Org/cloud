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

// CDP surfaces a mid-eval page navigation as one of these context errors.
const isNavigationDestroyedEval = (error: string): boolean =>
  error.includes('Execution context was destroyed') ||
  error.includes('Cannot find context with specified id') ||
  error.includes('Inspected target navigated or closed');

const scriptEnvelopeSchema = z.object({
  dryRunActions: z
    .array(z.object({ action: z.string(), selector: z.string() }))
    .optional()
    .default([]),
  dryRunUnverified: z.boolean().optional(),
  error: z.string().optional(),
  ok: z.boolean(),
  value: z.unknown().optional(),
});

/**
 * The static page-helper preamble injected before every workflow script.
 *
 * Helper design: text-based helpers (clickText, fillLabel, waitForText,
 * readText) mirror the safe-mode snapshot vocabulary — visible text, labels,
 * placeholders — so scripts written from a snapshot need no CSS selectors.
 * Selector helpers stay for pages where text targeting is ambiguous.
 *
 * Dry-run rules: mutations (click, fill, clickText, fillLabel) are recorded,
 * not performed. Waits stay REAL until the first recorded mutation — up to
 * that point the page is in its true state — and are recorded after it,
 * because a skipped click can never produce the awaited content. Reads are
 * always real.
 */
const PAGE_HELPERS_CODE = `
const dryRunActions = [];
const pageIsReal = () => !dryRun || dryRunActions.length === 0;
const isVisible = (el) => {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const normText = (value) => (value ?? '').replace(/\\s+/gu, ' ').trim().toLowerCase();
const unreachable = (message) => {
  if (dryRun && dryRunActions.length > 0) {
    const skipped = new Error(message + ' (not reachable in a dry run)');
    skipped.kiloDryRunUnverified = true;
    return skipped;
  }
  return new Error(message);
};
const findByText = (roots, target) => {
  const wanted = normText(target);
  if (wanted === '') { return null; }
  let partial = null;
  for (const el of roots) {
    if (!isVisible(el)) continue;
    const candidates = [
      el.getAttribute('aria-label'),
      el.textContent,
      el instanceof HTMLInputElement ? el.value : '',
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.placeholder : '',
    ];
    for (const candidate of candidates) {
      const have = normText(candidate);
      if (have === '') continue;
      if (have === wanted) return el;
      if (have.includes(wanted) && (partial === null || have.length < normText(partial.__kiloMatch).length)) {
        el.__kiloMatch = candidate;
        partial = el;
      }
    }
  }
  return partial;
};
const fillElement = (el, value) => {
  if (el instanceof HTMLSelectElement) {
    const option = [...el.options].find(
      (opt) => normText(opt.value) === normText(value) || normText(opt.textContent) === normText(value)
    );
    if (!option) {
      const labels = [...el.options].slice(0, 20).map((opt) => (opt.textContent ?? '').trim()).filter(Boolean);
      throw new Error('No option matches "' + value + '". Options: ' + labels.join(', ').slice(0, 300));
    }
    el.value = option.value;
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) { setter.call(el, value); } else { el.value = value; }
  } else if (el.isContentEditable) {
    el.textContent = value;
  } else {
    throw new Error('The matched element is not a fillable input. Target the inner input element, or use page.clickText to open it first.');
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitLimit = (timeoutMs) =>
  typeof timeoutMs === 'number' && timeoutMs > 0 ? Math.min(timeoutMs, 25000) : 15000;
const AUTO_WAIT_MS = 3000;
const autoWait = async (resolveTarget) => {
  const start = Date.now();
  let found = resolveTarget();
  while ((found === null || found === undefined) && pageIsReal() && Date.now() - start < AUTO_WAIT_MS) {
    await sleepMs(100);
    found = resolveTarget();
  }
  return found;
};
const CLICKABLE = 'a, button, [role="button"], [role="option"], [role="tab"], [role="menuitem"], [role="link"], [role="checkbox"], [role="radio"], input[type="submit"], input[type="button"], label, summary';
const FILLABLE = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"], [role="searchbox"]';
const page = {
  __q(selector) {
    const el = document.querySelector(selector);
    if (el === null) { throw unreachable('No element matches selector: ' + selector); }
    return el;
  },
  async click(selector) {
    const el = await autoWait(() => document.querySelector(selector));
    if (el === null) { throw unreachable('No element matches selector: ' + selector); }
    if (dryRun) { dryRunActions.push({ action: 'click', selector }); return; }
    el.click();
  },
  async clickText(text) {
    const el = await autoWait(() => findByText(document.querySelectorAll(CLICKABLE), text));
    if (el === null) { throw unreachable('No clickable element with text: ' + text); }
    if (dryRun) { dryRunActions.push({ action: 'clickText', selector: text }); return; }
    el.click();
  },
  async fill(selector, value) {
    const el = await autoWait(() => document.querySelector(selector));
    if (el === null) { throw unreachable('No element matches selector: ' + selector); }
    if (dryRun) { dryRunActions.push({ action: 'fill', selector }); return; }
    fillElement(el, value);
  },
  async fillLabel(labelText, value) {
    const resolveField = () => {
      let el = findByText(document.querySelectorAll(FILLABLE), labelText);
      if (el === null) {
        const label = findByText(document.querySelectorAll('label'), labelText);
        if (label !== null) {
          el = label.control ?? (label.htmlFor ? document.getElementById(label.htmlFor) : null) ?? label.querySelector(FILLABLE);
        }
      }
      return el;
    };
    const el = await autoWait(resolveField);
    if (el === null || el === undefined) { throw unreachable('No input with label, placeholder, or aria-label: ' + labelText); }
    if (dryRun) { dryRunActions.push({ action: 'fillLabel', selector: labelText }); return; }
    fillElement(el, value);
  },
  text(selector) { return (page.__q(selector).textContent ?? '').trim(); },
  textAll(selector) {
    return Array.from(document.querySelectorAll(selector))
      .map((el) => (el.textContent ?? '').trim());
  },
  readText(maxChars) {
    const limit = typeof maxChars === 'number' && maxChars > 0 ? Math.min(maxChars, 20000) : 6000;
    const text = (document.body?.innerText ?? '').replace(/\\n{3,}/gu, '\\n\\n').trim();
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  },
  attr(selector, name) { return page.__q(selector).getAttribute(name); },
  exists(selector) { return document.querySelector(selector) !== null; },
  hasText(text) { return normText(document.body?.innerText).includes(normText(text)); },
  sleep(ms) {
    const capped = typeof ms === 'number' && ms > 0 ? Math.min(ms, 5000) : 0;
    return sleepMs(capped);
  },
  navigate() {
    throw new Error('page.navigate does not exist. To open another page, return { navigate: "<url>", state: { … } } from the script; the runner navigates and re-runs the script on the new page.');
  },
  goto() {
    throw new Error('page.goto does not exist. To open another page, return { navigate: "<url>", state: { … } } from the script; the runner navigates and re-runs the script on the new page.');
  },
  async waitFor(selector, timeoutMs) {
    if (typeof selector === 'number') { return page.sleep(selector); }
    if (!pageIsReal()) { dryRunActions.push({ action: 'waitFor', selector }); return; }
    const limit = waitLimit(timeoutMs);
    const start = Date.now();
    while (document.querySelector(selector) === null) {
      if (Date.now() - start >= limit) {
        throw new Error('Timed out waiting for selector: ' + selector + ' (' + limit + 'ms). The element never appeared; check the selector or wait for a different one.');
      }
      await sleepMs(100);
    }
  },
  async waitForText(text, timeoutMs) {
    if (!pageIsReal()) { dryRunActions.push({ action: 'waitForText', selector: text }); return; }
    const limit = waitLimit(timeoutMs);
    const start = Date.now();
    while (!page.hasText(text)) {
      if (Date.now() - start >= limit) {
        throw new Error('Timed out waiting for text: ' + text + ' (' + limit + 'ms). The text never appeared on the page.');
      }
      await sleepMs(100);
    }
  },
};
`;

/**
 * Models pass the script either as a bare function body (the documented
 * contract) or as a complete function expression like
 * `async ({ page, state, input }) => { … }`. Wrapping an expression in a
 * body would define a function and return undefined, so expression-shaped
 * scripts are used directly instead.
 */
/**
 * Build the injected page code for a single workflow page eval.
 * The script is embedded with `JSON.stringify` and compiled at run time:
 * first as a function EXPRESSION (models pass `async ({ page }) => { … }`
 * despite the body contract), and when that does not compile, as the
 * documented async function body. An expression that evaluates to a
 * non-function (an IIFE) already ran during classification, so it reports a
 * script-shape error instead of running a second time as a body.
 * Compiling instead of pattern
 * matching classifies every shape correctly — a body that starts with a
 * helper function declaration is not an expression, and vice versa.
 * `input` is re-injected on every page so scripts never lose run inputs
 * across navigations; `state` carries only what the script returns.
 */
/* eslint-disable prefer-template, max-params -- Concatenation with JSON.stringify avoids template-literal injection from untrusted workflow scripts; the page code needs all four values. */
export const buildWorkflowPageCode = (
  script: string,
  state: unknown,
  dryRun: boolean,
  input: unknown = {}
): string =>
  'const dryRun = ' +
  JSON.stringify(dryRun) +
  ';\n' +
  PAGE_HELPERS_CODE +
  'const scriptText = ' +
  JSON.stringify(script) +
  ';\n' +
  'const AsyncFunctionCtor = Object.getPrototypeOf(async () => {}).constructor;\n' +
  'let workflow;\n' +
  'let compiledExpression;\n' +
  'try {\n' +
  "  compiledExpression = new Function('return (' + scriptText + '\\n);');\n" +
  '} catch {\n' +
  '  // Not an expression: fall through to the body form.\n' +
  '}\n' +
  'if (compiledExpression !== undefined) {\n' +
  '  // Invoking the probe runs an IIFE once (its side effects included); any outcome but a clean function must NOT reach the body form, which would execute it a second time.\n' +
  '  let candidate;\n' +
  '  try {\n' +
  '    candidate = compiledExpression();\n' +
  '  } catch (error) {\n' +
  "    return { ok: false, error: 'Workflow script threw while evaluating: ' + String(error && error.message ? error.message : error) + '. Pass an async ({ page, state, input }) => { … } function (or a bare function body); do not invoke it yourself.', dryRunActions };\n" +
  '  }\n' +
  "  if (typeof candidate === 'function') { workflow = candidate; }\n" +
  "  else { return { ok: false, error: 'Workflow script must be a function, but evaluated to a non-function value. Pass an async ({ page, state, input }) => { … } function (or a bare function body); do not invoke it yourself.', dryRunActions }; }\n" +
  '}\n' +
  'if (workflow === undefined) {\n' +
  "  workflow = new AsyncFunctionCtor('{ page, state, input }', scriptText);\n" +
  '}\n' +
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
  '    dryRunUnverified: error instanceof Error && error.kiloDryRunUnverified === true,\n' +
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

const formatWorkflowScopeText = (
  workflow: Pick<AgentWorkflow, 'scopeOrigin' | 'pathPrefix'>
): string => workflow.scopeOrigin + (workflow.pathPrefix ?? '');

/**
 * Echo a short preview of an invalid script return value so the caller can
 * see what the script actually produced, plus the two valid shapes.
 */
const invalidValueError = (value: unknown, dryRun: boolean): string => {
  let preview = '';
  try {
    preview = JSON.stringify(value) ?? String(value);
  } catch {
    preview = String(value);
  }
  if (preview.length > 200) {
    preview = `${preview.slice(0, 200)}…`;
  }

  const dryRunHint = dryRun
    ? ' This was a dry run: clicks and fills are recorded, not performed, so content they would produce never appears — return early (e.g. after page.exists checks) instead of reading absent results.'
    : '';

  return `Workflow script returned an invalid value: ${preview}. Return { done: true, result } to finish, or { navigate: "<url>", state: { … } } to continue on another page.${dryRunHint}`;
};

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
        error:
          'Workflow script returned { navigate } without a state object. Return { navigate: "<url>", state: { … } } — state must be a JSON object (use {} when nothing needs to carry over).',
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
        error: `Navigation target ${navigateUrl} is outside the workflow scope ${formatWorkflowScopeText(workflow)}. Navigate only within the scope, or save the workflow with a wider scope.`,
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
    return resultWithActions(
      {
        error:
          'Workflow script is not approved. Save it again with save_workflow (same workflowId) so the user can approve this version on the card.',
        ok: false,
      },
      dryRun,
      []
    );
  }

  // 2a. Input shape gate — before any navigation. Name the declared params: a weak model that sent a bare string loops on a generic message (measured), but corrects when told the exact object to send.
  if (
    input !== undefined &&
    (typeof input !== 'object' || input === null || Array.isArray(input))
  ) {
    const params = workflow.params ?? [];
    const exampleParam = params.find(param => param.required === true) ?? params[0];
    const example = exampleParam === undefined ? '{}' : `{"${exampleParam.name}": "<value>"}`;
    const declared =
      params.length > 0 ? params.map(param => param.name).join(', ') : 'none — omit input entirely';
    return resultWithActions(
      {
        error: `run_workflow input must be a JSON object mapping declared param names to values, e.g. ${example}. Declared params: ${declared}.`,
        ok: false,
      },
      dryRun,
      []
    );
  }

  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Preceding check guarantees a plain object or undefined.
  const normalizedInput = (input ?? {}) as Record<string, unknown>;

  /* Input is embedded in the injected page code on every page, so it carries
     the same bound as navigation state. */
  let serializedInput = '';
  try {
    serializedInput = JSON.stringify(normalizedInput);
  } catch {
    return resultWithActions(
      { error: 'run_workflow input is not JSON-serializable.', ok: false },
      dryRun,
      []
    );
  }
  if (serializedInput.length > MAX_WORKFLOW_STATE_LENGTH) {
    return resultWithActions(
      {
        error: `run_workflow input exceeds the size limit (${String(MAX_WORKFLOW_STATE_LENGTH)} characters). Pass only the values the workflow declares as params.`,
        ok: false,
      },
      dryRun,
      []
    );
  }

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
        {
          error: `Workflow startUrl ${workflow.startUrl} is outside the workflow scope ${formatWorkflowScopeText(workflow)}. Update the workflow so startUrl matches the scope.`,
          ok: false,
        },
        dryRun,
        []
      );
    }
    try {
      await deps.navigateTab(tabId, workflow.startUrl);
    } catch (error) {
      return resultWithActions(
        {
          error: `Navigation to the startUrl failed: ${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        },
        dryRun,
        []
      );
    }
    if (isRunStopped(signal)) {
      return resultWithActions({ error: 'Run stopped.', ok: false }, dryRun, []);
    }
  }

  // 3. Initialize before the loop. `state.input` mirrors `input` on the first
  // Page for scripts written against the old contract.
  let state: unknown = { input: normalizedInput };
  let pagesVisited = 0;
  let navigationRecoveries = 0;
  const dryRunActions: { action: string; selector: string }[] = [];

  // 4. Loop, at most MAX_WORKFLOW_PAGES_PER_RUN iterations.
  for (let pageIndex = 0; pageIndex < MAX_WORKFLOW_PAGES_PER_RUN; pageIndex++) {
    // A. Abort check.
    if (isRunStopped(signal)) {
      return resultWithActions({ error: 'Run stopped.', ok: false }, dryRun, dryRunActions);
    }

    // B. Scope check on current tab URL.
    let url = '';
    try {
      // eslint-disable-next-line no-await-in-loop -- Sequential workflow execution by design.
      url = await deps.getTabUrl(tabId);
    } catch (error) {
      return resultWithActions(
        {
          error: `Could not read the tab URL: ${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        },
        dryRun,
        dryRunActions
      );
    }
    if (isRunStopped(signal)) {
      return resultWithActions({ error: 'Run stopped.', ok: false }, dryRun, dryRunActions);
    }
    if (!matchesWorkflowScope(workflow, url)) {
      return resultWithActions(
        {
          error: `Tab is at ${url}, but this workflow only runs on ${formatWorkflowScopeText(workflow)}. Navigate the tab there first, or save the workflow with a startUrl so runs navigate automatically.`,
          ok: false,
          pageUrl: url,
        },
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
      // A real click can navigate the page mid-eval; the destroyed execution context IS the navigation the script wanted. Re-run the script on the landed page with the same state, exactly like the { navigate } path. Fixed 1.5 s settle and a 3-recovery cap; add a load-complete dep if flaky pages surface.
      if (!dryRun && isNavigationDestroyedEval(evalResult.error) && navigationRecoveries < 3) {
        navigationRecoveries += 1;
        // eslint-disable-next-line no-await-in-loop, promise/avoid-new -- Sequential workflow execution by design; a plain settle delay has no promise-returning primitive to defer to.
        await new Promise<void>(resolve => {
          setTimeout(resolve, 1500);
        });
        // eslint-disable-next-line no-continue -- Mirrors the { navigate } path: same state, next page iteration.
        continue;
      }
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
        { error: invalidValueError(evalResult.value, dryRun), ok: false, pageUrl: url },
        dryRun,
        dryRunActions
      );
    }

    // Accumulate dryRunActions.
    const pageActions = envelope.data.dryRunActions;
    dryRunActions.push(...pageActions);

    /* A dry run cannot reach content its own skipped clicks would have produced.
       Selectors up to the first recorded action are verified, so this reports
       success with the recorded actions instead of failing a correct script. */
    if (dryRun && envelope.data.dryRunUnverified === true) {
      return resultWithActions(
        {
          ok: true,
          pagesVisited,
          result: {
            dryRun: true,
            note: `Selectors before the first recorded action are verified. The script then stopped: ${envelope.data.error ?? 'a later selector was unreachable.'} That is expected in a dry run, because recorded clicks and fills never change the page. Ask the user to start a real run to verify the rest.`,
          },
        },
        dryRun,
        dryRunActions
      );
    }

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
      /* Same reasoning as above: a dry-run script that falls through without a
         return value usually read post-action content that never rendered. */
      if (dryRun && dryRunActions.length > 0) {
        return resultWithActions(
          {
            ok: true,
            pagesVisited,
            result: {
              dryRun: true,
              note: 'Selectors before the first recorded action are verified. The script returned no value, which is expected in a dry run when it reads content that recorded clicks and fills would have produced. Ask the user to start a real run to verify the rest.',
            },
          },
          dryRun,
          dryRunActions
        );
      }

      return resultWithActions(
        { error: invalidValueError(innerValue, dryRun), ok: false, pageUrl: url },
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
      try {
        // eslint-disable-next-line no-await-in-loop -- Sequential workflow execution by design.
        await deps.navigateTab(tabId, validationResult.navigateUrl);
      } catch (error) {
        return resultWithActions(
          {
            error: `Navigation to ${validationResult.navigateUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
            ok: false,
            pageUrl: url,
          },
          dryRun,
          dryRunActions
        );
      }
      // eslint-disable-next-line no-continue -- Clearer than deep nesting for this state machine.
      continue;
    }

    // Anything else is invalid.
    return resultWithActions(
      { error: invalidValueError(innerValue, dryRun), ok: false, pageUrl: url },
      dryRun,
      dryRunActions
    );
  }

  // 5. Loop exhausted.
  return resultWithActions(
    {
      error: `Workflow exceeded the page limit (${String(MAX_WORKFLOW_PAGES_PER_RUN)} pages). The script returned { navigate } on every page. Branch on state so the results page returns { done: true, result } — e.g. first page returns { navigate: url, state: { searched: true } }, and when state.searched is true the script reads the results and finishes.`,
      ok: false,
    },
    dryRun,
    dryRunActions
  );
};
