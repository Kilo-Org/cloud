import { describe, expect, it } from 'vitest';
import { HTML_LENGTH_EXPRESSION, getTabHtmlLength, listInspectableTabs } from './tab-debugger';
import type { ChromeDebuggerApi, ChromeDebuggerTargetInfo } from './tab-debugger';

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

  it('evaluates and returns the selected tab html length', async () => {
    const calls: unknown[] = [];
    const debuggerApi = createDebuggerApi({
      sendCommand: (target, method, params) => {
        calls.push({ method, params, target });
        return { result: { type: 'number', value: 12_345 } };
      },
    });

    await expect(getTabHtmlLength(debuggerApi, 7)).resolves.toBe(12_345);
    expect(debuggerApi.calls).toStrictEqual(['attach:7', 'detach:7']);
    expect(calls).toStrictEqual([
      {
        method: 'Runtime.evaluate',
        params: {
          expression: HTML_LENGTH_EXPRESSION,
          returnByValue: true,
        },
        target: { tabId: 7 },
      },
    ]);
  });

  it('detaches from the tab when evaluation fails', async () => {
    const debuggerApi = createDebuggerApi({
      sendCommand: () => {
        throw new Error('Evaluation failed.');
      },
    });

    await expect(getTabHtmlLength(debuggerApi, 7)).rejects.toThrow('Evaluation failed.');
    expect(debuggerApi.calls).toStrictEqual(['attach:7', 'detach:7']);
  });
});
