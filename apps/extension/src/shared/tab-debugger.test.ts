// @vitest-environment jsdom
/* eslint-disable max-lines, jest/max-expects -- the selector tests assert the full node list and round-trip each selector */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SELECTOR_LENGTH,
  evalInTab,
  evalInTabWithScripting,
  getPageSnapshotInTabWithScripting,
  getViewportScreenshotWithTabsApi,
  listInspectableTabs,
  listInspectableTabsWithTabsApi,
} from './tab-debugger';
import type {
  BrowserScriptingApi,
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerTargetInfo,
  PageSnapshot,
} from './tab-debugger';

const createDebuggerApi = ({
  sendCommand,
  targets,
}: {
  sendCommand?: ChromeDebuggerApi['sendCommand'];
  targets?: ChromeDebuggerTargetInfo[];
} = {}): ChromeDebuggerApi & { calls: string[] } => {
  const calls: string[] = [];

  return {
    attach: target => {
      calls.push(`attach:${target.tabId}`);
    },
    calls,
    detach: target => {
      calls.push(`detach:${target.tabId}`);
    },
    getTargets: () =>
      targets ?? [
        { tabId: 1, title: 'Kilo', type: 'page', url: 'https://app.kilo.ai/' },
        { tabId: 2, title: 'Chrome settings', type: 'page', url: 'chrome://settings' },
        { title: 'Extension worker', type: 'service_worker', url: 'chrome-extension://id/bg.js' },
        { tabId: 3, title: 'Local app', type: 'page', url: 'http://localhost:3001/' },
        { tabId: 4, title: 'Local image', type: 'page', url: 'file:///tmp/kilo-image.png' },
      ],
    sendCommand:
      sendCommand ??
      ((_target, _method, _params) => {
        calls.push('sendCommand');
        return { result: { type: 'number', value: 42 } };
      }),
  };
};

const restoreFailingPngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

// Activating the target tab (7) succeeds; restoring the previous tab (1) throws. Tracks the active tab so the capture-time re-verification sees the requested tab.
const createRestoreFailingTabsApi = (): BrowserTabsApi => {
  let activeTabId = 1;

  return {
    captureVisibleTab: () => restoreFailingPngDataUrl,
    get: tabId => ({ id: tabId, title: 'Target', url: 'https://example.com/', windowId: 3 }),
    query: () => [{ id: activeTabId, title: 'Previous', url: 'https://kilo.ai/', windowId: 3 }],
    update: tabId => {
      if (tabId === 1) {
        throw new Error('No tab with id: 1');
      }

      activeTabId = tabId;

      return { id: tabId, title: 'Tab', url: 'https://example.com/', windowId: 3 };
    },
  };
};

describe('tab debugger helpers', () => {
  it('lists only normal inspectable page tabs', async () => {
    await expect(listInspectableTabs(createDebuggerApi())).resolves.toStrictEqual([
      { id: 1, title: 'Kilo', url: 'https://app.kilo.ai/' },
      { id: 3, title: 'Local app', url: 'http://localhost:3001/' },
      { id: 4, title: 'Local image', url: 'file:///tmp/kilo-image.png' },
    ]);
  });

  it('evaluates dangerous-mode code in the selected tab', async () => {
    const calls: unknown[] = [];
    const debuggerApi = createDebuggerApi({
      sendCommand: (target, method, params) => {
        calls.push({ method, params, target });
        return { result: { type: 'number', value: 12_345 } };
      },
    });

    await expect(
      evalInTab({
        code: 'return document.documentElement.outerHTML.length;',
        debuggerApi,
        tabId: 7,
      })
    ).resolves.toStrictEqual({ ok: true, value: 12_345 });
    expect(debuggerApi.calls).toStrictEqual(['attach:7', 'detach:7']);
    expect(calls).toStrictEqual([
      {
        method: 'Runtime.evaluate',
        params: {
          awaitPromise: true,
          expression: '(async () => { return document.documentElement.outerHTML.length; })()',
          returnByValue: true,
          timeout: 5000,
        },
        target: { tabId: 7 },
      },
    ]);
  });

  it('returns eval errors and still detaches', async () => {
    const debuggerApi = createDebuggerApi({
      sendCommand: () => ({
        exceptionDetails: { text: 'ReferenceError: missingValue is not defined' },
        result: { type: 'object' },
      }),
    });

    await expect(
      evalInTab({
        code: 'return missingValue;',
        debuggerApi,
        tabId: 7,
      })
    ).resolves.toStrictEqual({
      error: 'Page evaluation failed: ReferenceError: missingValue is not defined',
      ok: false,
    });
    expect(debuggerApi.calls).toStrictEqual(['attach:7', 'detach:7']);
  });

  it('returns the eval result even when detach fails', async () => {
    const debuggerApi: ChromeDebuggerApi = {
      attach: () => {},
      detach: () => {
        throw new Error('Debugger is not attached to the tab with id: 7');
      },
      getTargets: () => [],
      sendCommand: () => ({ result: { type: 'number', value: 42 } }),
    };

    await expect(evalInTab({ code: 'return 42;', debuggerApi, tabId: 7 })).resolves.toStrictEqual({
      ok: true,
      value: 42,
    });
  });

  it('summarizes huge eval string results', async () => {
    const hugeValue = 'x'.repeat(8001);
    const debuggerApi = createDebuggerApi({
      sendCommand: () => ({
        result: { type: 'string', value: hugeValue },
      }),
    });

    await expect(
      evalInTab({
        code: 'return document.documentElement.outerHTML;',
        debuggerApi,
        tabId: 7,
      })
    ).resolves.toStrictEqual({
      ok: true,
      value: {
        originalLength: 8001,
        truncated: true,
        type: 'string',
        value: 'x'.repeat(8000),
      },
    });
  });

  it('lists normal page tabs through Firefox tabs API', async () => {
    const tabsApi: BrowserTabsApi = {
      query: () => [
        { id: 1, title: 'Kilo', url: 'https://app.kilo.ai/' },
        { id: 2, title: 'Firefox settings', url: 'about:preferences' },
        { id: 3, title: '', url: 'http://localhost:3001/' },
        { id: 4, title: 'Local image', url: 'file:///tmp/kilo-image.png' },
      ],
    };

    await expect(listInspectableTabsWithTabsApi(tabsApi)).resolves.toStrictEqual([
      { id: 1, title: 'Kilo', url: 'https://app.kilo.ai/' },
      { id: 3, title: 'http://localhost:3001/', url: 'http://localhost:3001/' },
      { id: 4, title: 'Local image', url: 'file:///tmp/kilo-image.png' },
    ]);
  });

  it('evaluates dangerous-mode code through Firefox scripting API', async () => {
    const calls: Parameters<BrowserScriptingApi['executeScript']>[0][] = [];
    const scriptingApi: BrowserScriptingApi = {
      executeScript: async details => {
        calls.push(details);
        return [{ result: await Promise.resolve(details.func(...details.args)) }];
      },
    };

    await expect(
      evalInTabWithScripting({
        code: 'return await Promise.resolve(12_345);',
        scriptingApi,
        tabId: 7,
      })
    ).resolves.toStrictEqual({ ok: true, value: 12_345 });
    expect(calls[0]?.func).toBeTypeOf('function');
    expect(
      calls.map(call => ({
        args: call.args,
        target: call.target,
        world: call.world,
      }))
    ).toStrictEqual([
      {
        args: ['return await Promise.resolve(12_345);'],
        target: { tabId: 7 },
        world: 'MAIN',
      },
    ]);
  });

  it('times out Firefox scripting eval requests', async () => {
    const scriptingApi: BrowserScriptingApi = {
      // eslint-disable-next-line promise/prefer-await-to-then
      executeScript: () => Promise.race([]),
    };

    await expect(
      evalInTabWithScripting({
        code: 'return await new Promise(() => {});',
        scriptingApi,
        tabId: 7,
        timeoutMs: 1,
      })
    ).resolves.toStrictEqual({ error: 'Page evaluation timed out.', ok: false });
  });

  it('reports Firefox scripting eval errors instead of a phantom success', async () => {
    const scriptingApi: BrowserScriptingApi = {
      executeScript: () => [{ error: { message: 'missingValue is not defined' } }],
    };

    await expect(
      evalInTabWithScripting({
        code: 'return missingValue;',
        scriptingApi,
        tabId: 7,
      })
    ).resolves.toStrictEqual({
      error: 'Page evaluation failed: missingValue is not defined',
      ok: false,
    });
  });

  it('reports Firefox scripting snapshot errors instead of a phantom success', async () => {
    const scriptingApi: BrowserScriptingApi = {
      executeScript: () => [{ error: 'Page snapshot timed out.' }],
    };

    await expect(
      getPageSnapshotInTabWithScripting({ scriptingApi, tabId: 7 })
    ).resolves.toStrictEqual({
      error: 'Failed to read page snapshot: Page snapshot timed out.',
      ok: false,
    });
  });

  it('rejects non-serializable Firefox scripting eval results', async () => {
    const scriptingApi: BrowserScriptingApi = {
      executeScript: () => {
        const value: { self?: unknown } = {};
        value.self = value;

        return [{ result: value }];
      },
    };

    await expect(
      evalInTabWithScripting({
        code: 'const value = {}; value.self = value; return value;',
        scriptingApi,
        tabId: 7,
      })
    ).resolves.toStrictEqual({
      error: 'Eval result was not JSON-serializable.',
      ok: false,
    });
  });

  it('passes the snapshot timeout into the injected scan', async () => {
    const calls: Parameters<BrowserScriptingApi['executeScript']>[0][] = [];
    const scriptingApi: BrowserScriptingApi = {
      executeScript: details => {
        calls.push(details);
        return [
          { result: { nodes: [], text: 'page text', title: 'Kilo', url: 'https://kilo.ai/' } },
        ];
      },
    };

    await expect(
      getPageSnapshotInTabWithScripting({
        scriptingApi,
        tabId: 7,
        timeoutMs: 123,
      })
    ).resolves.toStrictEqual({
      ok: true,
      value: { nodes: [], text: 'page text', title: 'Kilo', url: 'https://kilo.ai/' },
    });
    expect(
      calls.map(call => ({ args: call.args, target: call.target, world: call.world }))
    ).toStrictEqual([
      {
        args: ['123', String(MAX_SELECTOR_LENGTH)],
        target: { tabId: 7 },
        world: 'MAIN',
      },
    ]);
  });

  it('times out Firefox scripting snapshot requests', async () => {
    const scriptingApi: BrowserScriptingApi = {
      // eslint-disable-next-line promise/prefer-await-to-then
      executeScript: () => Promise.race([]),
    };

    await expect(
      getPageSnapshotInTabWithScripting({
        scriptingApi,
        tabId: 7,
        timeoutMs: 1,
      })
    ).resolves.toStrictEqual({ error: 'Page evaluation timed out.', ok: false });
  });

  it('captures a viewport screenshot for the selected tab and restores the active tab', async () => {
    const calls: unknown[] = [];
    const pngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
    let activeTabId = 1;
    const tabsApi: BrowserTabsApi = {
      captureVisibleTab: (windowId, options) => {
        calls.push({ name: 'captureVisibleTab', options, windowId });
        return pngDataUrl;
      },
      get: tabId => {
        calls.push({ name: 'get', tabId });
        return { id: tabId, title: 'Target', url: 'https://example.com/', windowId: 3 };
      },
      query: queryInfo => {
        calls.push({ name: 'query', queryInfo });
        return [{ id: activeTabId, title: 'Active', url: 'https://kilo.ai/', windowId: 3 }];
      },
      update: (tabId, updateProperties) => {
        calls.push({ name: 'update', tabId, updateProperties });
        activeTabId = tabId;
        return { id: tabId, title: 'Tab', url: 'https://example.com/', windowId: 3 };
      },
    };

    await expect(getViewportScreenshotWithTabsApi({ tabId: 7, tabsApi })).resolves.toStrictEqual({
      ok: true,
      value: {
        dataUrl: pngDataUrl,
        devicePixelRatio: 1,
        height: 1,
        mediaType: 'image/png',
        width: 1,
      },
    });
    expect(calls).toStrictEqual([
      { name: 'get', tabId: 7 },
      { name: 'query', queryInfo: { active: true, windowId: 3 } },
      { name: 'update', tabId: 7, updateProperties: { active: true } },
      { name: 'query', queryInfo: { active: true, windowId: 3 } },
      { name: 'captureVisibleTab', options: { format: 'png' }, windowId: 3 },
      { name: 'update', tabId: 1, updateProperties: { active: true } },
    ]);
  });

  it('refuses to capture when another tab is active at capture time', async () => {
    const tabsApi: BrowserTabsApi = {
      captureVisibleTab: () => restoreFailingPngDataUrl,
      get: tabId => ({ id: tabId, title: 'Target', url: 'https://example.com/', windowId: 3 }),
      // A competing switch keeps tab 9 active; the requested tab 7 never becomes active.
      query: () => [{ id: 9, title: 'Intruder', url: 'https://evil.example/', windowId: 3 }],
      update: tabId => ({ id: tabId, title: 'Tab', url: 'https://example.com/', windowId: 3 }),
    };

    await expect(getViewportScreenshotWithTabsApi({ tabId: 7, tabsApi })).resolves.toStrictEqual({
      error: 'The selected tab was not active at capture time.',
      ok: false,
    });
  });

  it('returns the screenshot even when restoring the previous tab fails', async () => {
    const tabsApi = createRestoreFailingTabsApi();

    await expect(getViewportScreenshotWithTabsApi({ tabId: 7, tabsApi })).resolves.toStrictEqual({
      ok: true,
      value: {
        dataUrl: restoreFailingPngDataUrl,
        devicePixelRatio: 1,
        height: 1,
        mediaType: 'image/png',
        width: 1,
      },
    });
  });

  it('serializes concurrent captures so they cannot interleave', async () => {
    const events: string[] = [];
    const captureStarted = Promise.withResolvers<void>();
    const firstCaptureReleased = Promise.withResolvers<void>();
    const createApi = (label: string, onCapture?: () => Promise<void>): BrowserTabsApi => {
      let activeTabId = 1;

      return {
        captureVisibleTab: async () => {
          events.push(`capture:${label}`);
          await onCapture?.();
          return restoreFailingPngDataUrl;
        },
        get: tabId => ({ id: tabId, title: 'Target', url: 'https://example.com/', windowId: 3 }),
        query: () => [{ id: activeTabId, title: 'Active', url: 'https://kilo.ai/', windowId: 3 }],
        update: tabId => {
          events.push(`update:${label}:${tabId}`);
          activeTabId = tabId;
          return { id: tabId, title: 'Tab', url: 'https://example.com/', windowId: 3 };
        },
      };
    };

    const first = getViewportScreenshotWithTabsApi({
      tabId: 7,
      tabsApi: createApi('A', async () => {
        captureStarted.resolve();
        await firstCaptureReleased.promise;
      }),
    });
    const second = getViewportScreenshotWithTabsApi({ tabId: 8, tabsApi: createApi('B') });

    await captureStarted.promise;
    expect(events).toStrictEqual(['update:A:7', 'capture:A']);

    firstCaptureReleased.resolve();
    await Promise.all([first, second]);

    // A fully finishes (capture + restore) before B touches its tab.
    expect(events).toStrictEqual([
      'update:A:7',
      'capture:A',
      'update:A:1',
      'update:B:8',
      'capture:B',
      'update:B:1',
    ]);
  });
});

const captureFixtureSnapshot = async (): Promise<PageSnapshot> => {
  // JSDOM reports zero rects, which the injected visibility check treats as hidden. Report a
  // 10x10 rect so captured fixtures participate in the snapshot.
  const rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 10, 10));
  const scriptingApi: BrowserScriptingApi = {
    executeScript: async details => [
      { result: await Promise.resolve(details.func(...details.args)) },
    ],
  };

  try {
    const result = await getPageSnapshotInTabWithScripting({ scriptingApi, tabId: 7 });

    if (!result.ok) {
      throw new Error('Expected a page snapshot result.');
    }

    // The mocked scripting API always runs the injected snapshot function.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- result.value is the injected function's PageSnapshot.
    return result.value as PageSnapshot;
  } finally {
    rectSpy.mockRestore();
  }
};

describe('injected page snapshot selector evidence', () => {
  it('gives every captured node a unique usable CSS selector', async () => {
    document.body.innerHTML = [
      '<button id="search" class="btn primary">Search flights</button>',
      '<button class="btn">Sort by best</button>',
      '<button class="btn">Sort by cheapest</button>',
      '<input aria-label="Where to?" placeholder="Where to?">',
      '<a href="https://example.com/flights">Flights</a>',
    ].join('');

    const snapshot = await captureFixtureSnapshot();
    const selectors = snapshot.nodes.map(node => node.selector);

    expect(selectors).toStrictEqual([
      'button#search',
      'button.btn:nth-of-type(2)',
      'button.btn:nth-of-type(3)',
      'input[aria-label="Where to?"]',
      'a',
    ]);

    for (const node of snapshot.nodes) {
      const matched = document.querySelector(node.selector);

      expect(matched).not.toBeNull();
    }
    for (const node of snapshot.nodes.filter(candidate => candidate.text !== undefined)) {
      const matched = document.querySelector(node.selector);

      expect(matched?.textContent?.trim()).toBe(node.text);
    }
  });

  it('escapes selector identifiers and attribute values into valid CSS', async () => {
    document.body.innerHTML = [
      '<button id="123 start">Odd id</button>',
      '<button class="a:b">Colon class</button>',
      '<input aria-label="say &quot;hi&quot;" placeholder="ignored">',
    ].join('');

    const snapshot = await captureFixtureSnapshot();
    const selectors = snapshot.nodes.map(node => node.selector);

    expect(selectors).toStrictEqual([
      String.raw`button#\31 23\ start`,
      String.raw`button.a\:b`,
      String.raw`input[aria-label="say \"hi\""]`,
    ]);

    for (const node of snapshot.nodes) {
      const matched = document.querySelector(node.selector);

      expect(matched).not.toBeNull();
    }
  });

  it('uniquely matches duplicate nested controls despite omitted duplicates', async () => {
    document.body.innerHTML = [
      '<div class="card"><button class="buy">Buy now</button></div>',
      '<div class="card"><button class="buy">Buy now</button></div>',
      '<div class="card"><button class="buy" style="display: none">Hidden duplicate</button></div>',
      '<main id="app"><button class="buy">Buy later</button></main>',
    ].join('');

    const snapshot = await captureFixtureSnapshot();
    const buttons = snapshot.nodes.filter(node => node.tag === 'button');
    const selectors = buttons.map(node => node.selector);

    expect(selectors).toStrictEqual([
      'div.card:nth-of-type(1) > button.buy:nth-of-type(1)',
      'div.card:nth-of-type(2) > button.buy:nth-of-type(1)',
      'main#app:nth-of-type(1) > button.buy:nth-of-type(1)',
    ]);

    for (const node of buttons) {
      const matched = document.querySelectorAll(node.selector);

      expect(matched).toHaveLength(1);
      expect(matched[0]?.textContent?.trim()).toBe(node.text);
    }
  });

  it('keeps selector inputs complete above the former truncation bounds', async () => {
    const longClass = `c${'x'.repeat(80)}`;
    const longLabel = `l${'y'.repeat(140)}`;
    const longName = `n${'z'.repeat(140)}`;
    document.body.innerHTML = [
      `<button class="${longClass}">Classed button</button>`,
      `<input aria-label="${longLabel}" placeholder="p">`,
      `<input name="${longName}" placeholder="q">`,
    ].join('');

    const snapshot = await captureFixtureSnapshot();
    const classed = snapshot.nodes.find(node => node.text === 'Classed button');

    expect(classed?.selector).toBe(`button.${longClass}`);

    const labelled = snapshot.nodes.find(node => node.selector.includes('aria-label'));

    expect(labelled?.selector).toBe(`input[aria-label="${longLabel}"]`);

    const named = snapshot.nodes.find(node => node.selector.includes('name'));

    expect(named?.selector).toBe(`input[name="${longName}"]`);

    for (const node of snapshot.nodes) {
      const matched = document.querySelector(node.selector);

      expect(matched).not.toBeNull();
    }
  });

  it('drops unbounded selector inputs that would exceed the maximum selector size', async () => {
    const hugeId = `i${'x'.repeat(600)}`;
    document.body.innerHTML = `<button id="${hugeId}">Huge id</button>`;

    const snapshot = await captureFixtureSnapshot();
    const [node] = snapshot.nodes;

    expect(node?.selector).toBe('button');
    expect(node?.selector.length).toBeLessThanOrEqual(MAX_SELECTOR_LENGTH);
    expect(node?.selector.length).toBeGreaterThan(0);

    for (const capturedNode of snapshot.nodes) {
      const matched = document.querySelector(capturedNode.selector);

      expect(matched).not.toBeNull();
    }
  });

  it('falls back to a shorter selector when an attribute value cannot fit', async () => {
    document.body.innerHTML = `<input aria-label="${'a'.repeat(600)}" placeholder="Search">`;

    const snapshot = await captureFixtureSnapshot();
    const [node] = snapshot.nodes;

    expect(node?.selector).toBe('input[placeholder="Search"]');
    expect(node?.selector.length).toBeLessThanOrEqual(MAX_SELECTOR_LENGTH);

    for (const capturedNode of snapshot.nodes) {
      const matched = document.querySelector(capturedNode.selector);

      expect(matched).not.toBeNull();
    }
  });

  it('escapes control characters into valid CSS and preserves exact attribute values', async () => {
    document.body.innerHTML = [
      '<button id="line\nbreak">Newline id</button>',
      '<button aria-label="tab\there">Tab label</button>',
      '<input name="  spaced  " placeholder="p">',
    ].join('');

    const snapshot = await captureFixtureSnapshot();
    const selectors = snapshot.nodes.map(node => node.selector);

    expect(selectors).toStrictEqual([
      String.raw`button#line\a break`,
      String.raw`button[aria-label="tab\9 here"]`,
      String.raw`input[name="  spaced  "]`,
    ]);

    for (const node of snapshot.nodes) {
      const matched = document.querySelector(node.selector);

      expect(matched).not.toBeNull();
    }
  });

  it('drops an over-long custom tag name and keeps a bounded verified selector', async () => {
    const longTag = `x-${'y'.repeat(520)}`;
    document.body.innerHTML = [
      `<${longTag} id="keep" role="button">Long tag</${longTag}>`,
      '<button id="other">Other</button>',
    ].join('');

    const snapshot = await captureFixtureSnapshot();
    const longTagNode = snapshot.nodes.find(node => node.selector === '#keep');

    expect(longTagNode?.selector).toBe('#keep');
    expect(longTagNode?.selector.length).toBeLessThanOrEqual(MAX_SELECTOR_LENGTH);
    expect(longTagNode?.tag.length).toBeGreaterThan(MAX_SELECTOR_LENGTH);

    for (const node of snapshot.nodes) {
      const matched = document.querySelectorAll(node.selector);

      expect(matched).toHaveLength(1);
    }
  });

  it('omits nodes that have no bounded unique selector', async () => {
    const openWraps = '<div class="wrap">'.repeat(30);
    const closeWraps = '</div>'.repeat(30);
    const nested = `${openWraps}<button class="go">Go</button>${closeWraps}`;
    document.body.innerHTML = `${nested}${nested}`;

    const snapshot = await captureFixtureSnapshot();

    // The two buttons are symmetric for every chain that fits within the bound, so no verified
    // Selector exists. Both nodes are omitted instead of exposing an ambiguous selector.
    expect(snapshot.nodes).toStrictEqual([]);
  });

  it('skips NUL-containing identifiers and attribute values with a verified fallback', async () => {
    document.body.innerHTML = [
      '<button class="nul">Nul id</button>',
      '<button id="normal" class="nul">Normal id</button>',
      '<input placeholder="Search">',
    ].join('');
    document.body.querySelector('button.nul')?.setAttribute('id', 'a\u0000b');
    document.body.querySelector('input')?.setAttribute('aria-label', 'l\u0000abel');

    const snapshot = await captureFixtureSnapshot();
    const selectors = snapshot.nodes.map(node => node.selector);

    expect(selectors).toStrictEqual([
      'button.nul:nth-of-type(1)',
      'button#normal',
      'input[placeholder="Search"]',
    ]);

    for (const node of snapshot.nodes) {
      const matched = document.querySelectorAll(node.selector);

      expect(matched).toHaveLength(1);
    }
  });
});
