/* eslint-disable max-lines -- Comprehensive test suite covering all feature states of the workflow runner; splitting would obscure coverage relationships. */
import { describe, expect, it } from 'vitest';
import { buildWorkflowPageCode, runWorkflow } from './agent-workflow-runner';
import { hashWorkflowScript } from './agent-workflows';
import type { AgentWorkflow } from './agent-workflows';

interface EvalTabOkResult {
  ok: true;
  value: unknown;
}
interface EvalTabErrResult {
  ok: false;
  error: string;
}
type EvalTabResult = EvalTabOkResult | EvalTabErrResult;

const createDeps = (overrides?: {
  evalResponses?: EvalTabResult[];
  navigateUrls?: string[];
  tabUrls?: string[];
}) => {
  let evalIdx = 0;
  let urlIdx = 0;

  const evalResponses = overrides?.evalResponses ?? [];
  const navigateUrls: string[] = [];
  const tabUrls = overrides?.tabUrls ?? [];

  return {
    evalInTab: (_tabId: number, _code: string): Promise<EvalTabResult> => {
      const result = evalResponses[evalIdx];
      evalIdx++;
      return Promise.resolve(
        result ?? { ok: true, value: { ok: true, value: { done: true, result: null } } }
      );
    },
    getTabUrl: (_tabId: number): Promise<string> => {
      const url = tabUrls[urlIdx] ?? 'https://shop.example.com/page';
      urlIdx++;
      return Promise.resolve(url);
    },
    navigateTab: (_tabId: number, url: string): Promise<void> => {
      navigateUrls.push(url);
      return Promise.resolve();
    },
    navigateUrls,
  };
};

const buildApprovedWorkflow = async (
  overrides?: Partial<AgentWorkflow>
): Promise<AgentWorkflow> => {
  const script = overrides?.script ?? 'return { done: true, result: 42 };';
  const hash = await hashWorkflowScript(script);
  return {
    approvedScriptHash: hash,
    createdAt: 1,
    description: 'Test workflow',
    id: 'wf-1',
    name: 'Test',
    scopeOrigin: 'https://shop.example.com',
    script,
    updatedAt: 1,
    ...overrides,
  };
};

describe('buildWorkflowPageCode function', () => {
  it('builds code with plain concatenation', () => {
    const script = 'return { done: true, result: 1 };';
    const code = buildWorkflowPageCode(script, { input: { key: 1 } }, false);

    expect(code).toContain('const dryRun = false');
    expect(code).toContain(
      'const workflow = async ({ page, state }) => { return { done: true, result: 1 }; }'
    );
    expect(code).toContain('"input":{"key":1}');
  });

  it('serializes dryRun as true', () => {
    const code = buildWorkflowPageCode('return 1;', {}, true);
    expect(code).toContain('const dryRun = true');
  });

  it('ends with return of the layer-2 envelope', () => {
    const code = buildWorkflowPageCode('return { done: true, result: 1 };', {}, false);
    expect(code.trimEnd()).toMatch(/}$/);
    expect(code).toContain('return { ok: true, value, dryRunActions }');
  });

  it('catches thrown errors and returns ok: false', () => {
    const code = buildWorkflowPageCode('throw new Error("fail");', {}, false);
    expect(code).toContain('return {');
    expect(code).toContain('ok: false,');
    expect(code).toContain('error: error instanceof Error ? error.message : String(error)');
  });
});

describe('runWorkflow function', () => {
  it('returns success for a single-page happy path', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        { ok: true, value: { dryRunActions: [], ok: true, value: { done: true, result: 42 } } },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({ ok: true, pagesVisited: 1, result: 42 });
  });

  it('returns success with pagesVisited for multi-page with state threading', async () => {
    const workflow = await buildApprovedWorkflow({
      script: `
        if (!state.first) {
          return { navigate: 'https://shop.example.com/page2', state: { first: true } };
        }
        return { done: true, result: 'done' };
      `,
    });
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: { navigate: 'https://shop.example.com/page2', state: { first: true } },
          },
        },
        { ok: true, value: { dryRunActions: [], ok: true, value: { done: true, result: 'done' } } },
      ],
      tabUrls: ['https://shop.example.com/page1', 'https://shop.example.com/page2'],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({ ok: true, pagesVisited: 2, result: 'done' });
    expect(deps.navigateUrls).toStrictEqual(['https://shop.example.com/page2']);
  });

  it('fails with thrown script error and page URL', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        { ok: true, value: { dryRunActions: [], error: 'Script exploded.', ok: false } },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Script exploded.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('fails for invalid return shape (no done or navigate)', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        { ok: true, value: { dryRunActions: [], ok: true, value: { something: 'else' } } },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result.ok).toBe(false);
    /* eslint-disable jest/no-conditional-in-test, jest/no-conditional-expect -- Discriminated union narrowing with preceding runtime assertion. */
    if (!result.ok) {
      expect(result.error).toBe('Workflow script returned an invalid value.');
      expect(result.pageUrl).toBe('https://shop.example.com/page');
    }
    /* eslint-enable jest/no-conditional-in-test, jest/no-conditional-expect */
  });

  it('fails for null/undefined inner value', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [{ ok: true, value: { dryRunActions: [], ok: true, value: null } }],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result.ok).toBe(false);
    /* eslint-disable jest/no-conditional-in-test, jest/no-conditional-expect -- Discriminated union narrowing with preceding runtime assertion. */
    if (!result.ok) {
      expect(result.error).toBe('Workflow script returned an invalid value.');
    }
    /* eslint-enable jest/no-conditional-in-test, jest/no-conditional-expect */
  });

  it('fails when transport fails (layer-1 error)', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [{ error: 'Tab closed.', ok: false }],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Tab closed.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('fails when navigation target is outside scope', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: { navigate: 'https://other.example.com/page', state: {} },
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Navigation target is outside the workflow scope.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('fails when tab URL is outside scope', async () => {
    const workflow = await buildApprovedWorkflow({
      scopeOrigin: 'https://shop.example.com',
    });
    const deps = createDeps({
      tabUrls: ['https://malicious.example.com/hijack'],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Tab is outside the workflow scope.',
      ok: false,
      pageUrl: 'https://malicious.example.com/hijack',
    });
  });

  it('fails for unapproved workflow', async () => {
    const workflow = await buildApprovedWorkflow({ approvedScriptHash: undefined });
    const deps = createDeps();

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({ error: 'Workflow script is not approved.', ok: false });
  });

  it('fails for approval hash mismatch', async () => {
    const workflow = await buildApprovedWorkflow({
      approvedScriptHash: 'deadbeef',
      script: 'return 1;',
    });
    const deps = createDeps();

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({ error: 'Workflow script is not approved.', ok: false });
  });

  it('fails when page limit is exceeded', async () => {
    // Create 21 navigate returns to exceed MAX_WORKFLOW_PAGES_PER_RUN (20).
    const navigateReturns = Array.from({ length: 21 }, (_unused, idx) => ({
      ok: true as const,
      value: {
        dryRunActions: [] as { action: string; selector: string }[],
        ok: true as const,
        value: {
          navigate: `https://shop.example.com/page${idx + 1}`,
          state: { page: idx },
        },
      },
    }));
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: navigateReturns,
      tabUrls: Array.from({ length: 21 }, (_unused, idx) => `https://shop.example.com/page${idx}`),
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow exceeded the page limit.',
      ok: false,
    });
  });

  it('fails when state exceeds MAX_WORKFLOW_STATE_LENGTH', async () => {
    const bigState = { data: 'x'.repeat(16_001) };
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: { navigate: 'https://shop.example.com/page2', state: bigState },
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow state exceeds the size limit.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('fails for circular state (non-serializable)', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: { navigate: 'https://shop.example.com/page2', state: circular },
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow state is not serializable.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('navigates to startUrl before running when set', async () => {
    const workflow = await buildApprovedWorkflow({
      startUrl: 'https://shop.example.com/product/1',
    });
    const deps = createDeps({
      evalResponses: [
        { ok: true, value: { dryRunActions: [], ok: true, value: { done: true, result: 42 } } },
      ],
      tabUrls: ['https://shop.example.com/product/1'],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result.ok).toBe(true);
    expect(deps.navigateUrls).toStrictEqual(['https://shop.example.com/product/1']);
  });

  it('fails when startUrl is outside scope without navigating', async () => {
    const workflow = await buildApprovedWorkflow({
      startUrl: 'https://other.example.com/evil',
    });
    const deps = createDeps();

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow startUrl is outside the workflow scope.',
      ok: false,
    });
    expect(deps.navigateUrls).toStrictEqual([]);
  });

  it('does not navigate when startUrl is empty string (clear sentinel)', async () => {
    const workflow = await buildApprovedWorkflow({
      startUrl: '',
    });
    const deps = createDeps({
      evalResponses: [
        { ok: true, value: { dryRunActions: [], ok: true, value: { done: true, result: 42 } } },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result.ok).toBe(true);
    // Empty string must NOT trigger navigation.
    expect(deps.navigateUrls).toStrictEqual([]);
  });

  it('stops on abort signal between pages', async () => {
    const workflow = await buildApprovedWorkflow({
      script: `
        return { navigate: 'https://shop.example.com/page2', state: { page: 2 } };
      `,
    });
    const controller = new AbortController();
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: { navigate: 'https://shop.example.com/page2', state: { page: 2 } },
          },
        },
      ],
    });

    // Override navigateTab to abort after the first page.
    const originalNavigateTab = deps.navigateTab;
    deps.navigateTab = (tabId, url): Promise<void> => {
      void originalNavigateTab(tabId, url);
      controller.abort();
      return Promise.resolve();
    };

    const result = await runWorkflow(deps, {
      signal: controller.signal,
      tabId: 1,
      workflow,
    });
    expect(result).toStrictEqual({ error: 'Run stopped.', ok: false });
  });

  it('dry run records click/fill actions across pages', async () => {
    const workflow = await buildApprovedWorkflow({
      script: `
        page.click('.buy-button');
        page.fill('.qty', '2');
        return { done: true, result: 'checked' };
      `,
    });
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [
              { action: 'click', selector: '.buy-button' },
              { action: 'fill', selector: '.qty' },
            ],
            ok: true,
            value: { done: true, result: 'checked' },
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { dryRun: true, tabId: 1, workflow });
    expect(result).toStrictEqual({
      dryRunActions: [
        { action: 'click', selector: '.buy-button' },
        { action: 'fill', selector: '.qty' },
      ],
      ok: true,
      pagesVisited: 1,
      result: 'checked',
    });
  });

  it('dry run aggregates actions and still appears on failure', async () => {
    const workflow = await buildApprovedWorkflow({
      script: `
        page.click('.bad-selector');
        return { done: true, result: 1 };
      `,
    });
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [{ action: 'click', selector: '.bad-selector' }],
            error: 'No element matches selector: .bad-selector',
            ok: false,
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { dryRun: true, tabId: 1, workflow });
    expect(result).toStrictEqual({
      dryRunActions: [{ action: 'click', selector: '.bad-selector' }],
      error: 'No element matches selector: .bad-selector',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('dry run still applies the approval gate', async () => {
    const workflow = await buildApprovedWorkflow({ approvedScriptHash: undefined });
    const deps = createDeps();

    const result = await runWorkflow(deps, { dryRun: true, tabId: 1, workflow });
    expect(result).toStrictEqual({
      dryRunActions: [],
      error: 'Workflow script is not approved.',
      ok: false,
    });
  });

  it('fails when envelope parsing fails (non-object value)', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [{ ok: true, value: 'just a string' }],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow script returned an unparseable value.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('counts pagesVisited per injection', async () => {
    const workflow = await buildApprovedWorkflow({
      script: `
        return { done: true, result: 1 };
      `,
    });
    const deps = createDeps({
      evalResponses: [
        { ok: true, value: { dryRunActions: [], ok: true, value: { done: true, result: 1 } } },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toMatchObject({ ok: true, pagesVisited: 1, result: 1 });
  });

  it('fails for null navigation state', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: { navigate: 'https://shop.example.com/page2', state: null },
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow script returned an invalid value.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('fails for primitive navigation state', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: { navigate: 'https://shop.example.com/page2', state: 42 },
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow script returned an invalid value.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('fails for array navigation state', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: {
              navigate: 'https://shop.example.com/page2',
              state: [{ key: 'val' }],
            },
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow script returned an invalid value.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('fails for undefined navigation state', async () => {
    const workflow = await buildApprovedWorkflow();
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [],
            ok: true,
            value: { navigate: 'https://shop.example.com/page2', state: undefined },
          },
        },
      ],
    });

    const result = await runWorkflow(deps, { tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow script returned an invalid value.',
      ok: false,
      pageUrl: 'https://shop.example.com/page',
    });
  });

  it('stops on abort after startUrl navigation, before the loop', async () => {
    const workflow = await buildApprovedWorkflow({
      startUrl: 'https://shop.example.com/product/1',
    });
    const controller = new AbortController();
    const deps = createDeps({
      tabUrls: ['https://shop.example.com/product/1'],
    });

    // Override navigateTab to abort after it completes.
    const originalNavigateTab = deps.navigateTab;
    deps.navigateTab = (tabId: number, url: string): Promise<void> => {
      void originalNavigateTab(tabId, url);
      controller.abort();
      return Promise.resolve();
    };

    const result = await runWorkflow(deps, {
      signal: controller.signal,
      tabId: 1,
      workflow,
    });
    expect(result).toStrictEqual({ error: 'Run stopped.', ok: false });
  });

  it('stops on abort after getTabUrl, before scope check', async () => {
    const workflow = await buildApprovedWorkflow();
    const controller = new AbortController();
    const deps = createDeps({
      tabUrls: ['https://shop.example.com/page'],
    });

    // Override getTabUrl to abort after it returns.
    const originalGetTabUrl = deps.getTabUrl;
    deps.getTabUrl = (tabId: number): Promise<string> => {
      const url = originalGetTabUrl(tabId);
      controller.abort();
      return Promise.resolve(url);
    };

    const result = await runWorkflow(deps, {
      signal: controller.signal,
      tabId: 1,
      workflow,
    });
    expect(result).toStrictEqual({ error: 'Run stopped.', ok: false });
  });

  it('stops on abort after evalInTab, before parsing envelope', async () => {
    const workflow = await buildApprovedWorkflow();
    const controller = new AbortController();
    const deps = createDeps({
      evalResponses: [
        { ok: true, value: { dryRunActions: [], ok: true, value: { done: true, result: 1 } } },
      ],
      tabUrls: ['https://shop.example.com/page'],
    });

    // Override evalInTab to abort after it returns.
    const originalEvalInTab = deps.evalInTab;
    deps.evalInTab = (tabId: number, code: string): Promise<EvalTabResult> => {
      const result = originalEvalInTab(tabId, code);
      controller.abort();
      return Promise.resolve(result);
    };

    const result = await runWorkflow(deps, {
      signal: controller.signal,
      tabId: 1,
      workflow,
    });
    expect(result).toStrictEqual({ error: 'Run stopped.', ok: false });
  });

  it('returns a clean failure for non-serializable initial input', async () => {
    const workflow = await buildApprovedWorkflow();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const deps = createDeps();
    const result = await runWorkflow(deps, { input: circular, tabId: 1, workflow });
    expect(result).toStrictEqual({
      error: 'Workflow initial input is not serializable.',
      ok: false,
    });
  });

  it('dry run aggregates actions across multiple pages', async () => {
    const workflow = await buildApprovedWorkflow({
      script: `
        page.click('.next-btn');
        return { navigate: 'https://shop.example.com/page2', state: { page: 2 } };
      `,
    });
    const deps = createDeps({
      evalResponses: [
        {
          ok: true,
          value: {
            dryRunActions: [{ action: 'click', selector: '.next-btn' }],
            ok: true,
            value: { navigate: 'https://shop.example.com/page2', state: { page: 2 } },
          },
        },
        {
          ok: true,
          value: {
            dryRunActions: [{ action: 'click', selector: '.submit-btn' }],
            ok: true,
            value: { done: true, result: 'done' },
          },
        },
      ],
      tabUrls: ['https://shop.example.com/page1', 'https://shop.example.com/page2'],
    });

    const result = await runWorkflow(deps, { dryRun: true, tabId: 1, workflow });
    expect(result).toStrictEqual({
      dryRunActions: [
        { action: 'click', selector: '.next-btn' },
        { action: 'click', selector: '.submit-btn' },
      ],
      ok: true,
      pagesVisited: 2,
      result: 'done',
    });
  });
});
