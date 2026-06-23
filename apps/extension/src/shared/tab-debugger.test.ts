import { describe, expect, it } from 'vitest';
import {
  evalInTab,
  evalInTabWithScripting,
  listInspectableTabs,
  listInspectableTabsWithTabsApi,
} from './tab-debugger';
import type {
  BrowserScriptingApi,
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerTargetInfo,
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
      ],
    sendCommand:
      sendCommand ??
      ((_target, _method, _params) => {
        calls.push('sendCommand');
        return { result: { type: 'number', value: 42 } };
      }),
  };
};

describe('tab debugger helpers', () => {
  it('lists only normal inspectable page tabs', async () => {
    await expect(listInspectableTabs(createDebuggerApi())).resolves.toStrictEqual([
      { id: 1, title: 'Kilo', url: 'https://app.kilo.ai/' },
      { id: 3, title: 'Local app', url: 'http://localhost:3001/' },
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
        exceptionDetails: { text: 'ReferenceError' },
        result: { type: 'object' },
      }),
    });

    await expect(
      evalInTab({
        code: 'return missingValue;',
        debuggerApi,
        tabId: 7,
      })
    ).resolves.toStrictEqual({ error: 'Page evaluation failed.', ok: false });
    expect(debuggerApi.calls).toStrictEqual(['attach:7', 'detach:7']);
  });

  it('lists normal page tabs through Firefox tabs API', async () => {
    const tabsApi: BrowserTabsApi = {
      query: () => [
        { id: 1, title: 'Kilo', url: 'https://app.kilo.ai/' },
        { id: 2, title: 'Firefox settings', url: 'about:preferences' },
        { id: 3, title: '', url: 'http://localhost:3001/' },
      ],
    };

    await expect(listInspectableTabsWithTabsApi(tabsApi)).resolves.toStrictEqual([
      { id: 1, title: 'Kilo', url: 'https://app.kilo.ai/' },
      { id: 3, title: 'http://localhost:3001/', url: 'http://localhost:3001/' },
    ]);
  });

  it('evaluates dangerous-mode code through Firefox scripting API', async () => {
    const calls: Parameters<BrowserScriptingApi['executeScript']>[0][] = [];
    const scriptingApi: BrowserScriptingApi = {
      executeScript: details => {
        calls.push(details);
        return [{ result: 12_345 }];
      },
    };

    await expect(
      evalInTabWithScripting({
        code: 'return document.documentElement.outerHTML.length;',
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
        args: ['return document.documentElement.outerHTML.length;'],
        target: { tabId: 7 },
        world: 'MAIN',
      },
    ]);
  });
});
