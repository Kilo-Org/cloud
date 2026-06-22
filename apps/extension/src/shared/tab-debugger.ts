export const DEBUGGER_PROTOCOL_VERSION = '1.3';
export const HTML_LENGTH_EXPRESSION = 'document.documentElement.outerHTML.length';
export const LIST_INSPECTABLE_TABS_MESSAGE = 'kilo.tabs.listInspectable';
export const GET_TAB_HTML_LENGTH_MESSAGE = 'kilo.tabs.getHtmlLength';
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
      readonly tabId: number;
      readonly type: typeof GET_TAB_HTML_LENGTH_MESSAGE;
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
      readonly length: number;
      readonly ok: true;
      readonly type: typeof GET_TAB_HTML_LENGTH_MESSAGE;
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

export const getTabHtmlLength = async (
  debuggerApi: ChromeDebuggerApi,
  tabId: number
): Promise<number> => {
  const target = { tabId };
  let attached = false;

  await debuggerApi.attach(target, DEBUGGER_PROTOCOL_VERSION);
  attached = true;

  try {
    const response = await debuggerApi.sendCommand(target, 'Runtime.evaluate', {
      expression: HTML_LENGTH_EXPRESSION,
      returnByValue: true,
    });

    if (!isRecord(response)) {
      throw new Error('Debugger did not return an HTML length.');
    }

    const { exceptionDetails, result } = response;

    if (exceptionDetails !== undefined) {
      throw new Error('Page evaluation failed.');
    }

    if (!isRecord(result) || typeof result['value'] !== 'number') {
      throw new Error('Debugger did not return an HTML length.');
    }

    return result['value'];
  } finally {
    if (attached) {
      await debuggerApi.detach(target);
    }
  }
};

const getEvalExpression = (code: string): string => `(async () => { ${code} })()`;

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

export const isTabDebuggerRequest = (value: unknown): value is TabDebuggerRequest => {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return false;
  }

  if (value['type'] === LIST_INSPECTABLE_TABS_MESSAGE) {
    return true;
  }

  if (value['type'] === GET_TAB_HTML_LENGTH_MESSAGE) {
    return typeof value['tabId'] === 'number';
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

  if (value['type'] === GET_TAB_HTML_LENGTH_MESSAGE) {
    return typeof value['length'] === 'number';
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
