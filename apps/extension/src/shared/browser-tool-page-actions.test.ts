/* eslint-disable jest/no-conditional-in-test, max-lines, require-await, typescript-eslint/require-await, unicorn/no-useless-undefined, vitest/prefer-called-once -- Fake session and tabs API return verbatim async responses so each per-tool assertion reads the union's own branch; the config also mandates toHaveBeenCalledTimes for single calls. */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserToolDialog, BrowserToolResolvedTarget } from './browser-tool-session';
import {
  BROWSER_TOOL_NO_DIALOG_ERROR,
  BROWSER_TOOL_NO_FILE_CHOOSER_ERROR,
  BROWSER_TOOL_NO_SELECTED_TAB_ERROR,
  MAX_BROWSER_EVALUATE_STRING_LENGTH,
  isPageBrowserToolName,
  runPageBrowserTool,
  serializeBrowserEvaluateResult,
} from './browser-tool-page-actions';
import type {
  BrowserToolFileChooser,
  BrowserToolPageActionSession,
  BrowserToolPageTabsApi,
} from './browser-tool-page-actions';
import type { BrowserTabInfo, EvalTabResult, WebMcpDiscoveryResult } from './tab-debugger';

type SendHandler = (
  method: string,
  params?: Record<string, unknown>
) => Record<string, unknown> | undefined;

const defaultEvaluateHandler: SendHandler = (_method, params) => {
  const expression = typeof params?.['expression'] === 'string' ? params['expression'] : '';

  if (expression === 'document.readyState') {
    return { result: { type: 'string', value: 'complete' } };
  }

  if (expression.includes('location.href')) {
    return { result: { value: { title: 'Example', url: 'https://example.com/' } } };
  }

  if (expression === 'document.title') {
    return { result: { value: 'Example' } };
  }

  if (expression === 'document.documentElement.outerHTML') {
    return { result: { value: '<html></html>' } };
  }

  return { result: { value: true } };
};

const createFakeSession = () => {
  const sends: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const handlers = new Map<string, SendHandler>();
  const dispose = vi.fn(async () => {});
  let dialog: BrowserToolDialog | undefined = undefined;
  let fileChooser: BrowserToolFileChooser | undefined = undefined;
  let resolvedTarget: BrowserToolResolvedTarget | undefined = undefined;

  handlers.set('Runtime.evaluate', defaultEvaluateHandler);
  handlers.set('Runtime.callFunctionOn', () => ({ result: { value: 'from-element' } }));
  handlers.set('DOM.resolveNode', () => ({ object: { objectId: 'object-1' } }));
  handlers.set('Page.captureScreenshot', () => ({ data: 'cG5n' }));

  const session: BrowserToolPageActionSession = {
    dispose,
    resolveTarget: async () => resolvedTarget,
    send: async (method, params) => {
      sends.push({ method, params });
      const handler = handlers.get(method);

      return handler?.(method, params);
    },
    takeDialog: () => dialog,
    takeFileChooser: () => fileChooser,
  };

  return {
    dispose,
    handlers,
    methods: () => sends.map(entry => entry.method),
    sends,
    session,
    setDialog: (next: BrowserToolDialog | undefined) => {
      dialog = next;
    },
    setFileChooser: (next: BrowserToolFileChooser | undefined) => {
      fileChooser = next;
    },
    setResolvedTarget: (next: BrowserToolResolvedTarget | undefined) => {
      resolvedTarget = next;
    },
  };
};

const inspectableTab = (id: number, title: string, url: string): BrowserTabInfo => ({
  active: id === 1,
  id,
  title,
  url,
});

const createFakeTabsApi = (initialTabs: BrowserTabInfo[]) => {
  const tabs = [...initialTabs];
  const creates: { url?: string }[] = [];
  const removes: number[] = [];
  const updates: { active: boolean; tabId: number }[] = [];

  const tabsApi: BrowserToolPageTabsApi = {
    create: async createProperties => {
      creates.push(createProperties);
      const tab: BrowserTabInfo = {
        id: 99,
        title: 'New tab',
        url: createProperties.url ?? 'https://new.example.com/',
      };

      tabs.push(tab);

      return tab;
    },
    get: async tabId => tabs.find(tab => tab.id === tabId) ?? {},
    query: async () => [...tabs],
    remove: async tabId => {
      removes.push(tabId);
      const index = tabs.findIndex(tab => tab.id === tabId);

      if (index !== -1) {
        tabs.splice(index, 1);
      }
    },
    update: async (tabId, updateProperties) => {
      updates.push({ active: updateProperties.active, tabId });

      return tabs.find(tab => tab.id === tabId) ?? {};
    },
  };

  return { creates, removes, tabsApi, updates };
};

const tabsWithOnePage = () =>
  createFakeTabsApi([inspectableTab(1, 'Example', 'https://example.com/')]);

describe('browser-tool-page-actions', () => {
  it('recognizes the page and lifecycle tool names in both spellings', () => {
    expect(isPageBrowserToolName('browser_navigate')).toBe(true);
    expect(isPageBrowserToolName('kilo_browser_run_code_unsafe')).toBe(true);
    expect(isPageBrowserToolName('browser_click')).toBe(false);
    expect(isPageBrowserToolName('eval')).toBe(false);
  });

  describe('browser_navigate', () => {
    it('navigates the selected tab and reports the final url and title', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_navigate',
        { url: 'https://example.com/next' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(sends).toContainEqual({
        method: 'Page.navigate',
        params: { url: 'https://example.com/next' },
      });
      expect(result).toStrictEqual({
        ok: true,
        value: { title: 'Example', url: 'https://example.com/' },
      });
    });

    it('requires a url', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends } = createFakeSession();

      const result = await runPageBrowserTool('browser_navigate', {}, session, {
        tabId: 1,
        tabsApi: tabs.tabsApi,
      });

      expect(result.ok).toBe(false);
      expect(sends).toHaveLength(0);
    });

    it('reports a navigation error instead of the previous page identity', async () => {
      const tabs = tabsWithOnePage();
      const { handlers, session, methods } = createFakeSession();

      handlers.set('Page.navigate', () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }));

      const result = await runPageBrowserTool(
        'kilo_browser_navigate',
        { url: 'https://missing.example.com/' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result).toStrictEqual({
        error:
          'browser_navigate could not load https://missing.example.com/: net::ERR_NAME_NOT_RESOLVED',
        ok: false,
      });
      // The failed navigation must not read the previous page's title/url as success.
      expect(methods()).not.toContain('Runtime.evaluate');
    });
  });

  describe('browser_navigate_back', () => {
    it('navigates to the previous history entry and returns the url reached', async () => {
      const tabs = tabsWithOnePage();
      const { handlers, session, sends } = createFakeSession();

      handlers.set('Page.getNavigationHistory', () => ({
        currentIndex: 1,
        entries: [
          { id: 11, title: 'A', url: 'https://a.example.com/' },
          { id: 22, title: 'B', url: 'https://b.example.com/' },
        ],
      }));

      const result = await runPageBrowserTool('kilo_browser_navigate_back', {}, session, {
        tabId: 1,
        tabsApi: tabs.tabsApi,
      });

      expect(sends).toContainEqual({
        method: 'Page.navigateToHistoryEntry',
        params: { entryId: 11 },
      });
      expect(result).toStrictEqual({
        ok: true,
        value: { title: 'Example', url: 'https://example.com/' },
      });
    });

    it('reports no previous page instead of navigating', async () => {
      const tabs = tabsWithOnePage();
      const { handlers, session, methods } = createFakeSession();

      handlers.set('Page.getNavigationHistory', () => ({
        currentIndex: 0,
        entries: [{ id: 11, title: 'A', url: 'https://a.example.com/' }],
      }));

      const result = await runPageBrowserTool('browser_navigate_back', {}, session, {
        tabId: 1,
        tabsApi: tabs.tabsApi,
      });

      expect(result.ok).toBe(false);
      expect(methods()).not.toContain('Page.navigateToHistoryEntry');
    });
  });

  describe('browser_close', () => {
    it('closes the current tab and the next call reports no selected tab', async () => {
      const tabs = tabsWithOnePage();
      const { dispose, session } = createFakeSession();

      const result = await runPageBrowserTool('kilo_browser_close', {}, session, {
        tabId: 1,
        tabsApi: tabs.tabsApi,
      });

      expect(result).toStrictEqual({ ok: true, value: 'Closed the tab.' });
      expect(tabs.removes).toStrictEqual([1]);
      expect(dispose).toHaveBeenCalledTimes(1);

      const next = await runPageBrowserTool(
        'kilo_browser_navigate',
        { url: 'https://example.com/' },
        undefined,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(next).toStrictEqual({ error: BROWSER_TOOL_NO_SELECTED_TAB_ERROR, ok: false });
    });
  });

  describe('browser_tabs', () => {
    it('lists index, title, url and marks the agent target', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'First', 'https://first.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);

      const result = await runPageBrowserTool('kilo_browser_tabs', { action: 'list' }, undefined, {
        tabId: 2,
        tabsApi: tabs.tabsApi,
      });

      expect(result).toStrictEqual({
        ok: true,
        value: {
          tabs: [
            { index: 0, selected: false, title: 'First', url: 'https://first.example.com/' },
            { index: 1, selected: true, title: 'Second', url: 'https://second.example.com/' },
          ],
        },
      });
    });

    it('opens a new tab at the requested url', async () => {
      const tabs = tabsWithOnePage();

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'new', url: 'https://new.example.com/' },
        undefined,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(tabs.creates).toStrictEqual([{ url: 'https://new.example.com/' }]);
      expect(result).toStrictEqual({
        ok: true,
        value: { selected: true, tabId: 99, title: 'New tab', url: 'https://new.example.com/' },
      });
    });

    it('closes the current tab when the index is omitted', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'First', 'https://first.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);
      const { dispose, session } = createFakeSession();

      const result = await runPageBrowserTool('kilo_browser_tabs', { action: 'close' }, session, {
        tabId: 2,
        tabsApi: tabs.tabsApi,
      });

      expect(tabs.removes).toStrictEqual([2]);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual({ ok: true, value: 'Closed the tab.' });
    });

    it('closes a tab by index without disposing the agent target session', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'First', 'https://first.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);
      const { dispose, session } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'close', index: 1 },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(tabs.removes).toStrictEqual([2]);
      expect(dispose).not.toHaveBeenCalled();
      expect(result).toStrictEqual({ ok: true, value: 'Closed the tab.' });
    });

    it('selects a tab by index and activates it like the panel picker', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'First', 'https://first.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'select', index: 1 },
        undefined,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(tabs.updates).toStrictEqual([{ active: true, tabId: 2 }]);
      expect(result).toStrictEqual({
        ok: true,
        value: { selected: true, tabId: 2, title: 'Second', url: 'https://second.example.com/' },
      });
    });

    it('rejects a select without an index', async () => {
      const tabs = tabsWithOnePage();

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'select' },
        undefined,
        {
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(result.ok).toBe(false);
      expect(tabs.updates).toHaveLength(0);
    });
  });

  describe('browser_resize', () => {
    it('sets the device metrics override', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_resize',
        { height: 600, width: 800 },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(sends).toStrictEqual([
        {
          method: 'Emulation.setDeviceMetricsOverride',
          params: { deviceScaleFactor: 1, height: 600, mobile: false, width: 800 },
        },
      ]);
      expect(result).toStrictEqual({ ok: true, value: { height: 600, width: 800 } });
    });

    it('clears the previous override on a later call', async () => {
      const tabs = tabsWithOnePage();
      const { session, methods } = createFakeSession();

      await runPageBrowserTool('kilo_browser_resize', { height: 600, width: 800 }, session, {
        tabId: 1,
        tabsApi: tabs.tabsApi,
      });
      await runPageBrowserTool('kilo_browser_resize', { height: 720, width: 1280 }, session, {
        tabId: 1,
        tabsApi: tabs.tabsApi,
      });

      expect(methods()).toStrictEqual([
        'Emulation.setDeviceMetricsOverride',
        'Emulation.clearDeviceMetricsOverride',
        'Emulation.setDeviceMetricsOverride',
      ]);
    });

    it('rejects non-positive and non-finite sizes before touching the tab', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends } = createFakeSession();

      const results = await Promise.all(
        [
          { height: 600, width: 0 },
          { height: -1, width: 800 },
          { height: 600, width: Number.POSITIVE_INFINITY },
          { height: Number.NaN, width: 800 },
          { height: 600, width: 'wide' },
        ].map(args =>
          runPageBrowserTool('kilo_browser_resize', args, session, {
            tabId: 1,
            tabsApi: tabs.tabsApi,
          })
        )
      );

      for (const result of results) {
        expect(result.ok).toBe(false);
      }

      expect(sends).toHaveLength(0);
    });
  });

  describe('browser_handle_dialog', () => {
    it('answers the dialog the session buffered', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends, setDialog } = createFakeSession();

      setDialog({ message: 'Continue?', type: 'confirm' });

      const result = await runPageBrowserTool(
        'kilo_browser_handle_dialog',
        { accept: true, promptText: 'yes' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(sends).toContainEqual({
        method: 'Page.handleJavaScriptDialog',
        params: { accept: true, promptText: 'yes' },
      });
      expect(result).toStrictEqual({
        ok: true,
        value: { accepted: true, message: 'Continue?', type: 'confirm' },
      });
    });

    it('reports no dialog when none is open', async () => {
      const tabs = tabsWithOnePage();
      const { session, methods } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_handle_dialog',
        { accept: true },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result).toStrictEqual({ error: BROWSER_TOOL_NO_DIALOG_ERROR, ok: false });
      expect(methods()).not.toContain('Page.handleJavaScriptDialog');
    });
  });

  describe('browser_file_upload', () => {
    it('sets the files on the intercepted chooser input', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends, setFileChooser } = createFakeSession();

      setFileChooser({ backendNodeId: 42 });

      const result = await runPageBrowserTool(
        'kilo_browser_file_upload',
        { paths: ['/tmp/a.txt', '/tmp/b.txt'] },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(sends).toContainEqual({
        method: 'DOM.setFileInputFiles',
        params: { backendNodeId: 42, files: ['/tmp/a.txt', '/tmp/b.txt'] },
      });
      expect(result).toStrictEqual({
        ok: true,
        value: { files: ['/tmp/a.txt', '/tmp/b.txt'] },
      });
    });

    it('cancels the chooser when paths is omitted', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends, setFileChooser } = createFakeSession();

      setFileChooser({ nodeId: 7 });

      const result = await runPageBrowserTool('kilo_browser_file_upload', {}, session, {
        tabId: 1,
        tabsApi: tabs.tabsApi,
      });

      expect(sends).toContainEqual({
        method: 'DOM.setFileInputFiles',
        params: { files: [], nodeId: 7 },
      });
      expect(result).toStrictEqual({ ok: true, value: { cancelled: true } });
    });

    it('names the extension limit when no chooser is pending', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_file_upload',
        { paths: ['/tmp/a.txt'] },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result).toStrictEqual({ error: BROWSER_TOOL_NO_FILE_CHOOSER_ERROR, ok: false });
      expect(BROWSER_TOOL_NO_FILE_CHOOSER_ERROR).toContain('Kilo extension');
      // The message states the platform limit, not an upload-control hint.
      expect(BROWSER_TOOL_NO_FILE_CHOOSER_ERROR).toContain(
        'does not intercept the page file chooser'
      );
      expect(BROWSER_TOOL_NO_FILE_CHOOSER_ERROR).not.toContain('click the upload control first');
      expect(sends).toHaveLength(0);
    });
  });

  describe('browser_evaluate', () => {
    it('evaluates the function without a target', async () => {
      const tabs = tabsWithOnePage();
      const { handlers, session, sends } = createFakeSession();

      handlers.set('Runtime.evaluate', () => ({ result: { value: 'hello' } }));

      const result = await runPageBrowserTool(
        'kilo_browser_evaluate',
        { function: '() => "hello"' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(sends).toContainEqual({
        method: 'Runtime.evaluate',
        params: { awaitPromise: true, expression: '(() => "hello")()', returnByValue: true },
      });
      expect(result).toStrictEqual({ ok: true, value: 'hello' });
    });

    it('passes the resolved element when a target is given', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends, setResolvedTarget } = createFakeSession();

      setResolvedTarget({ backendNodeId: 7, kind: 'ref', ref: 'e1' });

      const result = await runPageBrowserTool(
        'kilo_browser_evaluate',
        { element: 'Save button', function: '(element) => element.textContent', target: 'e1' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(sends).toContainEqual({
        method: 'DOM.resolveNode',
        params: { backendNodeId: 7 },
      });
      expect(sends).toContainEqual({
        method: 'Runtime.callFunctionOn',
        params: {
          awaitPromise: true,
          functionDeclaration: 'function() { return ((element) => element.textContent)(this); }',
          objectId: 'object-1',
          returnByValue: true,
        },
      });
      expect(result).toStrictEqual({ ok: true, value: 'from-element' });
    });

    it('reports an element that the snapshot refs cannot resolve', async () => {
      const tabs = tabsWithOnePage();
      const { session, methods } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_evaluate',
        { function: '(element) => element.textContent', target: 'e404' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result.ok).toBe(false);
      expect(methods()).not.toContain('Runtime.callFunctionOn');
    });

    it('truncates an oversized string result with its original length', () => {
      const oversized = 'x'.repeat(MAX_BROWSER_EVALUATE_STRING_LENGTH + 25);

      expect(serializeBrowserEvaluateResult(oversized)).toStrictEqual({
        ok: true,
        value: {
          originalLength: oversized.length,
          truncated: true,
          type: 'string',
          value: oversized.slice(0, MAX_BROWSER_EVALUATE_STRING_LENGTH),
        },
      });
    });

    it('rejects a non-serializable result', () => {
      expect(serializeBrowserEvaluateResult(1n)).toStrictEqual({
        error: 'Eval result was not JSON-serializable.',
        ok: false,
      });
    });
  });

  describe('browser_run_code_unsafe', () => {
    it('runs the snippet with a page backed by the session primitives', async () => {
      const tabs = tabsWithOnePage();
      const { session, methods } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_run_code_unsafe',
        { code: 'async (page) => { const title = await page.title(); return title; }' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(methods()).toContain('Runtime.evaluate');
      expect(result).toStrictEqual({ ok: true, value: 'Example' });
    });

    it('presses a printable key with the metadata the browser needs to type it', async () => {
      const tabs = tabsWithOnePage();
      const { session, sends } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_run_code_unsafe',
        { code: 'async (page) => { await page.press("a"); return true; }' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result).toStrictEqual({ ok: true, value: true });
      const keyDown = sends.find(entry => entry.method === 'Input.dispatchKeyEvent');
      expect(keyDown?.params).toMatchObject({
        code: 'KeyA',
        key: 'a',
        text: 'a',
        type: 'keyDown',
      });
    });

    it('reports a navigation error from page.goto', async () => {
      const tabs = tabsWithOnePage();
      const { handlers, session } = createFakeSession();

      handlers.set('Page.navigate', () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }));

      const result = await runPageBrowserTool(
        'kilo_browser_run_code_unsafe',
        { code: 'async (page) => { await page.goto("https://down.example.com/"); return true; }' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result).toStrictEqual({
        error:
          'browser_run_code_unsafe failed: page.goto could not load https://down.example.com/: net::ERR_CONNECTION_REFUSED',
        ok: false,
      });
    });

    it('names the unsupported method in a tool error', async () => {
      const tabs = tabsWithOnePage();
      const { session } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_run_code_unsafe',
        { code: 'async (page) => { await page.getByRole("button"); }' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error).toContain('page.getByRole');
      expect(result.ok ? '' : result.error).toContain('not supported by the Kilo extension');
    });

    it('names the filesystem limit when only a filename is given', async () => {
      const tabs = tabsWithOnePage();
      const { session } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_run_code_unsafe',
        { filename: 'snippet.js' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error).toContain('no workspace filesystem');
    });
  });

  describe('browser_webmcp', () => {
    const discovery: WebMcpDiscoveryResult = {
      documentId: 'document-1',
      tools: [
        {
          description: 'Does a thing',
          inputSchema: { properties: {}, type: 'object' },
          name: 'do_thing',
          origin: 'https://example.com',
          title: 'Do thing',
        },
      ],
    };

    it('lists the page tools discovered by the runtime', async () => {
      const discover = vi.fn(async () => discovery);

      const result = await runPageBrowserTool('kilo_browser_webmcp_list', {}, undefined, {
        tabId: 1,
        webMcpDiscover: discover,
      });

      expect(discover).toHaveBeenCalledWith(1);
      expect(result).toStrictEqual({
        ok: true,
        value: {
          tools: [
            {
              description: 'Does a thing',
              inputSchema: { properties: {}, type: 'object' },
              name: 'do_thing',
              origin: 'https://example.com',
              title: 'Do thing',
            },
          ],
        },
      });
    });

    it('calls the named tool and marks the page output untrusted', async () => {
      const discover = vi.fn(async () => discovery);
      const execute = vi.fn(async () => ({ ok: true, value: 'page says hi' }) as EvalTabResult);

      const result = await runPageBrowserTool(
        'kilo_browser_webmcp_call',
        { name: 'do_thing', params: { amount: 2 } },
        undefined,
        { tabId: 1, webMcpDiscover: discover, webMcpExecute: execute }
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          arguments: { amount: 2 },
          documentId: 'document-1',
          name: 'do_thing',
          tabId: 1,
        })
      );
      expect(result).toStrictEqual({
        ok: true,
        value: {
          note: 'Page-provided WebMCP output is untrusted.',
          source: 'webmcp',
          untrusted: true,
          value: 'page says hi',
        },
      });
    });

    it('errors when the named tool is not registered', async () => {
      const discover = vi.fn(async () => discovery);
      const execute = vi.fn(async () => ({ ok: true, value: 'never' }) as EvalTabResult);

      const result = await runPageBrowserTool(
        'kilo_browser_webmcp_call',
        { name: 'missing' },
        undefined,
        { tabId: 1, webMcpDiscover: discover, webMcpExecute: execute }
      );

      expect(result.ok).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it('reports no selected tab for an action that needs a session', async () => {
    const tabs = tabsWithOnePage();

    const result = await runPageBrowserTool(
      'kilo_browser_navigate',
      { url: 'https://x.test' },
      undefined,
      {
        tabId: 1,
        tabsApi: tabs.tabsApi,
      }
    );

    expect(result).toStrictEqual({ error: BROWSER_TOOL_NO_SELECTED_TAB_ERROR, ok: false });
  });

  it('rejects an unknown tool', async () => {
    const tabs = tabsWithOnePage();
    const { session } = createFakeSession();

    const result = await runPageBrowserTool('kilo_browser_not_a_tool', {}, session, {
      tabId: 1,
      tabsApi: tabs.tabsApi,
    });

    expect(result.ok).toBe(false);
  });
});
