/* eslint-disable max-lines */
export const DEBUGGER_PROTOCOL_VERSION = '1.3';
export const LIST_INSPECTABLE_TABS_MESSAGE = 'kilo.tabs.listInspectable';
export const EVAL_TAB_MESSAGE = 'kilo.tabs.eval';
export const DEFAULT_EVAL_TIMEOUT_MS = 5000;

export interface ChromeDebuggerTargetInfo {
  readonly attached?: boolean;
  readonly tabId?: number;
  readonly title?: string;
  readonly type?: string;
  readonly url?: string;
}

export interface ChromeDebuggerTarget {
  readonly tabId: number;
}

export interface ChromeDebuggerApi {
  readonly attach: (target: ChromeDebuggerTarget, requiredVersion: string) => Promise<void> | void;
  readonly detach: (target: ChromeDebuggerTarget) => Promise<void> | void;
  readonly getTargets: () => Promise<ChromeDebuggerTargetInfo[]> | ChromeDebuggerTargetInfo[];
  readonly sendCommand: (
    target: ChromeDebuggerTarget,
    method: string,
    commandParams?: Record<string, unknown>
  ) => unknown;
}

export interface BrowserTabInfo {
  readonly id?: number;
  readonly title?: string;
  readonly url?: string;
}

export interface BrowserTabsApi {
  readonly query: (
    queryInfo: Record<string, unknown>
  ) => Promise<BrowserTabInfo[]> | BrowserTabInfo[];
}

export interface BrowserScriptingInjectionResult {
  readonly result?: unknown;
}

export interface BrowserScriptingApi {
  readonly executeScript: (details: {
    readonly args: string[];
    readonly func: (code: string) => unknown;
    readonly target: { readonly tabId: number };
    readonly world: 'MAIN';
  }) => Promise<BrowserScriptingInjectionResult[]> | BrowserScriptingInjectionResult[];
}

export interface InspectableTab {
  readonly id: number;
  readonly title: string;
  readonly url: string;
}

export type EvalTabResult =
  | {
      readonly description?: string;
      readonly ok: true;
      readonly value?: unknown;
    }
  | {
      readonly error: string;
      readonly ok: false;
    };

export type TabDebuggerRequest =
  | {
      readonly type: typeof LIST_INSPECTABLE_TABS_MESSAGE;
    }
  | {
      readonly code: string;
      readonly tabId: number;
      readonly timeoutMs?: number;
      readonly type: typeof EVAL_TAB_MESSAGE;
    };

export type TabDebuggerResponse =
  | {
      readonly ok: true;
      readonly tabs: InspectableTab[];
      readonly type: typeof LIST_INSPECTABLE_TABS_MESSAGE;
    }
  | {
      readonly result: EvalTabResult;
      readonly ok: true;
      readonly type: typeof EVAL_TAB_MESSAGE;
    }
  | {
      readonly error: string;
      readonly ok: false;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNormalPageUrl = (url: string | undefined): url is string =>
  url?.startsWith('http://') === true || url?.startsWith('https://') === true;

export const listInspectableTabs = async (
  debuggerApi: ChromeDebuggerApi
): Promise<InspectableTab[]> => {
  const targets = await debuggerApi.getTargets();

  return targets
    .filter(
      (
        target
      ): target is ChromeDebuggerTargetInfo & { readonly tabId: number; readonly url: string } =>
        target.type === 'page' && typeof target.tabId === 'number' && isNormalPageUrl(target.url)
    )
    .map(target => {
      const title = target.title?.trim();

      return {
        id: target.tabId,
        title: title === undefined || title === '' ? target.url : title,
        url: target.url,
      };
    });
};

export const listInspectableTabsWithTabsApi = async (
  tabsApi: BrowserTabsApi
): Promise<InspectableTab[]> => {
  const tabs = await tabsApi.query({});

  return tabs
    .filter(
      (tab): tab is BrowserTabInfo & { readonly id: number; readonly url: string } =>
        typeof tab.id === 'number' && isNormalPageUrl(tab.url)
    )
    .map(tab => {
      const title = tab.title?.trim();

      return {
        id: tab.id,
        title: title === undefined || title === '' ? tab.url : title,
        url: tab.url,
      };
    });
};

const getEvalExpression = (code: string): string => `(async () => { ${code} })()`;

const runInjectedEval = (code: string): unknown =>
  // eslint-disable-next-line eslint/no-new-func, typescript-eslint/no-implied-eval, typescript-eslint/no-unsafe-call
  new Function(`return (async () => { ${code} })()`)();

const withTimeout = async <Result>(
  promise: Promise<Result>,
  timeoutMs: number
): Promise<Result> => {
  let timeout: ReturnType<typeof setTimeout> | undefined = undefined;

  try {
    return await Promise.race([
      promise,
      // eslint-disable-next-line promise/avoid-new
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Page evaluation timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

export const evalInTab = async ({
  code,
  debuggerApi,
  tabId,
  timeoutMs = DEFAULT_EVAL_TIMEOUT_MS,
}: {
  readonly code: string;
  readonly debuggerApi: ChromeDebuggerApi;
  readonly tabId: number;
  readonly timeoutMs?: number;
}): Promise<EvalTabResult> => {
  const target = { tabId };
  let attached = false;

  try {
    await debuggerApi.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attached = true;

    const response = await debuggerApi.sendCommand(target, 'Runtime.evaluate', {
      awaitPromise: true,
      expression: getEvalExpression(code),
      returnByValue: true,
      timeout: timeoutMs,
    });

    if (!isRecord(response)) {
      return { error: 'Debugger returned an invalid eval response.', ok: false };
    }

    const { exceptionDetails, result } = response;

    if (exceptionDetails !== undefined) {
      return { error: 'Page evaluation failed.', ok: false };
    }

    if (!isRecord(result)) {
      return { error: 'Debugger returned an invalid eval result.', ok: false };
    }

    const description =
      typeof result['description'] === 'string' ? result['description'] : undefined;

    return {
      ok: true,
      ...(description === undefined ? {} : { description }),
      ...('value' in result ? { value: result['value'] } : {}),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Page evaluation failed.',
      ok: false,
    };
  } finally {
    if (attached) {
      await debuggerApi.detach(target);
    }
  }
};

export const evalInTabWithScripting = async ({
  code,
  scriptingApi,
  tabId,
  timeoutMs = DEFAULT_EVAL_TIMEOUT_MS,
}: {
  readonly code: string;
  readonly scriptingApi: BrowserScriptingApi;
  readonly tabId: number;
  readonly timeoutMs?: number;
}): Promise<EvalTabResult> => {
  try {
    const [response] = await withTimeout(
      Promise.resolve(
        scriptingApi.executeScript({
          args: [code],
          func: runInjectedEval,
          target: { tabId },
          world: 'MAIN',
        })
      ),
      timeoutMs
    );

    return { ok: true, value: response?.result };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Page evaluation failed.',
      ok: false,
    };
  }
};

export const isTabDebuggerRequest = (value: unknown): value is TabDebuggerRequest => {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return false;
  }

  if (value['type'] === LIST_INSPECTABLE_TABS_MESSAGE) {
    return true;
  }

  return (
    value['type'] === EVAL_TAB_MESSAGE &&
    typeof value['tabId'] === 'number' &&
    typeof value['code'] === 'string' &&
    (value['timeoutMs'] === undefined || typeof value['timeoutMs'] === 'number')
  );
};

export const isTabDebuggerResponse = (value: unknown): value is TabDebuggerResponse => {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') {
    return false;
  }

  if (!value['ok']) {
    return typeof value['error'] === 'string';
  }

  if (value['type'] === LIST_INSPECTABLE_TABS_MESSAGE) {
    return (
      Array.isArray(value['tabs']) &&
      value['tabs'].every(
        tab =>
          isRecord(tab) &&
          typeof tab['id'] === 'number' &&
          typeof tab['title'] === 'string' &&
          typeof tab['url'] === 'string'
      )
    );
  }

  if (value['type'] === EVAL_TAB_MESSAGE) {
    const { result } = value;
    return (
      isRecord(result) &&
      typeof result['ok'] === 'boolean' &&
      (result['ok'] || typeof result['error'] === 'string')
    );
  }

  return false;
};
