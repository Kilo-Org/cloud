/* eslint-disable jest/no-conditional-in-test, max-lines, require-await, typescript-eslint/require-await, unicorn/no-useless-undefined, vitest/prefer-called-once -- Fake session and tabs API return verbatim async responses so each per-tool assertion reads the union's own branch; the config also mandates toHaveBeenCalledTimes for single calls. */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_TAB_OUTSIDE_GROUP_ERROR, RUN_CODE_UNSUPPORTED_ERROR } from './browser-agent-checks';
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
import type {
  BrowserTabInfo,
  EvalTabResult,
  WebMcpDiscoveryResult,
  WebMcpToolDescriptor,
} from './tab-debugger';

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
  const creates: { active?: boolean; url?: string }[] = [];
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
      updates.push({ active: updateProperties.active === true, tabId });

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

    it('opens a new tab at the requested url without taking the foreground', async () => {
      const tabs = tabsWithOnePage();

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'new', url: 'https://new.example.com/' },
        undefined,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(tabs.creates).toStrictEqual([{ active: false, url: 'https://new.example.com/' }]);
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

    it('lists only the agent session group and numbers it from zero', async () => {
      // The user's own tab (1) sits in the same window; the agent's session holds only tab 2.
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'Bank', 'https://bank.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);

      const result = await runPageBrowserTool('kilo_browser_tabs', { action: 'list' }, undefined, {
        agentAccess: {
          actOrigins: [],
          groupTabs: [2],
          navigateOrigins: [],
          readableOrigins: ['https://bank.example.com'],
        },
        tabId: 2,
        tabsApi: tabs.tabsApi,
      });

      // A read grant for the user's origin does not put their tab in the list: the session group is the boundary.
      expect(result).toStrictEqual({
        ok: true,
        value: '- 0: (current) [Second](https://second.example.com/)',
      });
      expect(JSON.stringify(result)).not.toContain('bank.example.com');
    });

    it('hides how many tabs the user has open', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'Bank', 'https://bank.example.com/'),
        inspectableTab(2, 'Agent', 'https://agent.example.com/'),
        inspectableTab(3, 'Mail', 'https://mail.example.com/'),
        inspectableTab(4, 'Shop', 'https://shop.example.com/'),
      ]);

      const result = await runPageBrowserTool('kilo_browser_tabs', { action: 'list' }, undefined, {
        agentAccess: { actOrigins: [], groupTabs: [2], navigateOrigins: [], readableOrigins: [] },
        tabId: 2,
        tabsApi: tabs.tabsApi,
      });

      // A withheld entry per user tab would still report the count: three tabs they did not open for the agent.
      expect(result).toStrictEqual({
        ok: true,
        value: '- 0: (current) [Agent](https://agent.example.com/)',
      });
    });

    it('lists a shared tab beside the session tab, numbered in list order', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'Bank', 'https://bank.example.com/'),
        inspectableTab(2, 'Agent', 'https://agent.example.com/'),
        inspectableTab(3, 'Shared', 'https://shared.example.com/'),
      ]);

      const result = await runPageBrowserTool('kilo_browser_tabs', { action: 'list' }, undefined, {
        agentAccess: {
          actOrigins: [],
          groupTabs: [2, 3],
          navigateOrigins: [],
          readableOrigins: [],
        },
        tabId: 2,
        tabsApi: tabs.tabsApi,
      });

      expect(result).toStrictEqual({
        ok: true,
        value: [
          '- 0: (current) [Agent](https://agent.example.com/)',
          '- 1: [Shared](https://shared.example.com/)',
        ].join('\n'),
      });
    });

    it('matches the text Playwright MCP prints for the same tabs', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'First', 'https://first.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);

      const result = await runPageBrowserTool('kilo_browser_tabs', { action: 'list' }, undefined, {
        agentAccess: {
          actOrigins: [],
          groupTabs: [1, 2],
          navigateOrigins: [],
          readableOrigins: [],
        },
        tabId: 2,
        tabsApi: tabs.tabsApi,
      });

      // Upstream's own list output for two pages, one current.
      expect(result).toStrictEqual({
        ok: true,
        value: [
          '- 0: [First](https://first.example.com/)',
          '- 1: (current) [Second](https://second.example.com/)',
        ].join('\n'),
      });
    });

    it('keeps listing every tab for a side-panel caller', async () => {
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

    it('selects the listed index, not the index counting the user tabs', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'Bank', 'https://bank.example.com/'),
        inspectableTab(2, 'Agent', 'https://agent.example.com/'),
        inspectableTab(3, 'Other agent tab', 'https://other.example.com/'),
      ]);

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'select', index: 1 },
        undefined,
        {
          agentAccess: {
            actOrigins: [],
            groupTabs: [2, 3],
            navigateOrigins: [],
            readableOrigins: [],
          },
          tabId: 2,
          tabsApi: tabs.tabsApi,
        }
      );

      // The agent list holds tabs 2 and 3, so its index 1 is tab 3 — not the browser's index 1, which is tab 2.
      expect(tabs.updates).toStrictEqual([{ active: true, tabId: 3 }]);
      expect(result).toStrictEqual({
        ok: true,
        value: {
          selected: true,
          tabId: 3,
          title: 'Other agent tab',
          url: 'https://other.example.com/',
        },
      });
    });

    it('closes the listed index, not the index counting the user tabs', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'Bank', 'https://bank.example.com/'),
        inspectableTab(2, 'Agent', 'https://agent.example.com/'),
        inspectableTab(3, 'Other agent tab', 'https://other.example.com/'),
      ]);
      const { dispose, session } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'close', index: 1 },
        session,
        {
          agentAccess: {
            actOrigins: [],
            groupTabs: [2, 3],
            navigateOrigins: [],
            readableOrigins: [],
          },
          tabId: 2,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(tabs.removes).toStrictEqual([3]);
      // The closed tab is not the agent's target, so the target's session survives.
      expect(dispose).not.toHaveBeenCalled();
      expect(result).toStrictEqual({ ok: true, value: 'Closed the tab.' });
    });

    it('refuses an index past the agent list that names the user’s tab', async () => {
      // The agent's tab comes first in browser order, so browser index 1 is the user's tab and lies past the list.
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'Agent', 'https://agent.example.com/'),
        inspectableTab(2, 'Bank', 'https://bank.example.com/'),
      ]);

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'select', index: 1 },
        undefined,
        {
          agentAccess: { actOrigins: [], groupTabs: [1], navigateOrigins: [], readableOrigins: [] },
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(result).toStrictEqual({ error: AGENT_TAB_OUTSIDE_GROUP_ERROR, ok: false });
      expect(tabs.updates).toStrictEqual([]);
    });

    it('answers one refusal for every index past the agent list, never the browser’s tab count', async () => {
      // One reachable tab and four inspectable ones: a different answer for 1-3 than for 4 would report how many tabs the browser holds.
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'Agent', 'https://agent.example.com/'),
        inspectableTab(2, 'Bank', 'https://bank.example.com/'),
        inspectableTab(3, 'Mail', 'https://mail.example.com/'),
        inspectableTab(4, 'Docs', 'https://docs.example.com/'),
        inspectableTab(5, 'News', 'https://news.example.com/'),
      ]);
      const options = {
        agentAccess: {
          actOrigins: [],
          groupTabs: [1],
          navigateOrigins: [],
          readableOrigins: [],
        },
        tabId: 1,
        tabsApi: tabs.tabsApi,
      };
      const answers = await Promise.all(
        [1, 2, 3, 4, 9].map(index =>
          runPageBrowserTool('kilo_browser_tabs', { action: 'select', index }, undefined, options)
        )
      );

      for (const answer of answers) {
        expect(answer).toStrictEqual({ error: AGENT_TAB_OUTSIDE_GROUP_ERROR, ok: false });
      }

      expect(tabs.updates).toStrictEqual([]);
    });

    it('lists a tab in the agent session group even without a read grant', async () => {
      const tabs = createFakeTabsApi([inspectableTab(2, 'Second', 'https://second.example.com/')]);

      const result = await runPageBrowserTool('kilo_browser_tabs', { action: 'list' }, undefined, {
        agentAccess: {
          actOrigins: [],
          groupTabs: [2],
          navigateOrigins: [],
          readableOrigins: [],
        },
        tabId: 2,
        tabsApi: tabs.tabsApi,
      });

      expect(result).toStrictEqual({
        ok: true,
        value: '- 0: (current) [Second](https://second.example.com/)',
      });
    });

    it('refuses to select a tab outside the group without act on its origin', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'First', 'https://first.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'select', index: 1 },
        undefined,
        {
          agentAccess: {
            actOrigins: ['https://first.example.com'],
            groupTabs: [],
            navigateOrigins: [],
            readableOrigins: [],
          },
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(result.ok).toBe(false);
      expect(tabs.updates).toHaveLength(0);
    });

    it('selects a tab in the agent session group', async () => {
      const tabs = createFakeTabsApi([inspectableTab(2, 'Second', 'https://second.example.com/')]);

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'select', index: 0 },
        undefined,
        {
          agentAccess: { actOrigins: [], groupTabs: [2], navigateOrigins: [], readableOrigins: [] },
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(result.ok).toBe(true);
      expect(tabs.updates).toStrictEqual([{ active: true, tabId: 2 }]);
    });

    it('refuses to close a tab outside the group without act on its origin', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'First', 'https://first.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);
      const { session } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'close', index: 1 },
        session,
        {
          agentAccess: {
            actOrigins: ['https://first.example.com'],
            groupTabs: [],
            navigateOrigins: [],
            readableOrigins: [],
          },
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(result.ok).toBe(false);
      expect(tabs.removes).toHaveLength(0);
    });

    it('refuses a new tab whose origin the agent may not navigate to', async () => {
      const tabs = tabsWithOnePage();

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'new', url: 'https://new.example.com/' },
        undefined,
        {
          agentAccess: { actOrigins: [], groupTabs: [], navigateOrigins: [], readableOrigins: [] },
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(result.ok).toBe(false);
      expect(tabs.creates).toHaveLength(0);
    });

    it('refuses a select allowed only by an act grant outside the group', async () => {
      const tabs = createFakeTabsApi([
        inspectableTab(1, 'First', 'https://first.example.com/'),
        inspectableTab(2, 'Second', 'https://second.example.com/'),
      ]);

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'select', index: 1 },
        undefined,
        {
          agentAccess: {
            actOrigins: ['https://second.example.com'],
            groupTabs: [],
            navigateOrigins: [],
            readableOrigins: [],
          },
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(result.ok).toBe(false);
      expect(tabs.updates).toHaveLength(0);
    });

    it('names the missing navigate grant when a new tab origin is ungranted', async () => {
      const tabs = tabsWithOnePage();

      const result = await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'new', url: 'https://new.example.com/' },
        undefined,
        {
          agentAccess: { actOrigins: [], groupTabs: [], navigateOrigins: [], readableOrigins: [] },
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).toContain('navigate grant');
    });

    it('records a created tab with the tab that opened it', async () => {
      const tabs = tabsWithOnePage();
      const created: [number, number | undefined][] = [];

      await runPageBrowserTool(
        'kilo_browser_tabs',
        { action: 'new', url: 'https://new.example.com/' },
        undefined,
        {
          noteTabCreated: (tabId, openerTabId) => created.push([tabId, openerTabId]),
          tabId: 1,
          tabsApi: tabs.tabsApi,
        }
      );

      expect(created).toStrictEqual([[99, 1]]);
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
      // The message is shown with the modal state, to a caller allowed to read it, and never echoed here.
      expect(result).toStrictEqual({ ok: true, value: { accepted: true, type: 'confirm' } });
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
    it('refuses Playwright code without touching the page and points to browser_evaluate', async () => {
      const tabs = tabsWithOnePage();
      const { session, methods } = createFakeSession();

      const result = await runPageBrowserTool(
        'kilo_browser_run_code_unsafe',
        { code: 'async (page) => { const title = await page.title(); return title; }' },
        session,
        { tabId: 1, tabsApi: tabs.tabsApi }
      );

      expect(result).toStrictEqual({ error: RUN_CODE_UNSUPPORTED_ERROR, ok: false });
      expect(RUN_CODE_UNSUPPORTED_ERROR).toContain('browser_evaluate');
      expect(methods()).toStrictEqual([]);
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

    it('lists only the tools an agent caller may read', async () => {
      const discover = vi.fn(async () => ({
        documentId: 'document-1',
        tools: [
          ...discovery.tools,
          {
            description: 'Hidden from the caller',
            inputSchema: { properties: {}, type: 'object' },
            name: 'hidden_thing',
            origin: 'https://bank.example.com',
            title: 'Hidden thing',
          },
          {
            description: 'Names no origin',
            inputSchema: { properties: {}, type: 'object' },
            name: 'originless_thing',
            origin: '',
            title: 'Originless thing',
          },
        ],
      }));

      const scoped = await runPageBrowserTool('kilo_browser_webmcp_list', {}, undefined, {
        agentScope: { readableOrigins: ['https://example.com'] },
        tabId: 1,
        webMcpDiscover: discover,
      });

      // A withheld tool leaves no trace: no count, no origin, nothing to notice.
      expect(scoped).toStrictEqual({
        ok: true,
        value: { tools: [discovery.tools[0]] },
      });

      const unscoped = await runPageBrowserTool('kilo_browser_webmcp_list', {}, undefined, {
        tabId: 1,
        webMcpDiscover: discover,
      });

      expect(unscoped).toStrictEqual({
        ok: true,
        value: {
          tools: [
            discovery.tools[0],
            {
              description: 'Hidden from the caller',
              inputSchema: { properties: {}, type: 'object' },
              name: 'hidden_thing',
              origin: 'https://bank.example.com',
              title: 'Hidden thing',
            },
            {
              description: 'Names no origin',
              inputSchema: { properties: {}, type: 'object' },
              name: 'originless_thing',
              origin: '',
              title: 'Originless thing',
            },
          ],
        },
      });
    });

    it('refuses a WebMCP call that carries an argument the tool does not take', async () => {
      const discover = vi.fn(async () => discovery);
      const execute = vi.fn(async () => ({ ok: true, value: 'never' }) as EvalTabResult);

      const result = await runPageBrowserTool(
        'kilo_browser_webmcp_call',
        { frame: 'main', name: 'do_thing' },
        undefined,
        { tabId: 1, webMcpDiscover: discover, webMcpExecute: execute }
      );

      expect(result).toStrictEqual({
        error: 'browser_webmcp_call does not take "frame"; it takes a tool name and its params.',
        ok: false,
      });
      expect(discover).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('keeps the tool-name wording for a call with no name', async () => {
      const result = await runPageBrowserTool('kilo_browser_webmcp_call', { name: '' }, undefined, {
        tabId: 1,
        webMcpDiscover: vi.fn(async () => discovery),
        webMcpExecute: vi.fn(),
      });

      expect(result).toStrictEqual({
        error: 'browser_webmcp_call needs a tool name.',
        ok: false,
      });
    });

    it('refuses a WebMCP call whose tool names no origin', async () => {
      const originless = {
        description: 'Does a thing',
        inputSchema: { properties: {}, type: 'object' },
        name: 'do_thing',
        origin: '',
        title: 'Do thing',
      } satisfies WebMcpToolDescriptor;
      const discover = vi.fn(async () => ({
        documentId: 'document-1',
        tools: [originless],
      }));
      const execute = vi.fn(async () => ({ ok: true, value: 'never' }) as EvalTabResult);

      const result = await runPageBrowserTool(
        'kilo_browser_webmcp_call',
        { name: 'do_thing' },
        undefined,
        { tabId: 1, webMcpDiscover: discover, webMcpExecute: execute }
      );

      expect(result).toStrictEqual({
        error:
          'WebMCP tool "do_thing" does not name the origin it belongs to, so the call was refused.',
        ok: false,
      });
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
