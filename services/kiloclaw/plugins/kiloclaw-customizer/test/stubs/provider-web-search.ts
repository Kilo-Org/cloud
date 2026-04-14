export const DEFAULT_SEARCH_COUNT = 5;

const cache = new Map<string, Record<string, unknown>>();

type PostParams = {
  url: string;
  timeoutSeconds: number;
  apiKey: string;
  body: Record<string, unknown>;
  errorLabel: string;
  extraHeaders?: Record<string, string>;
};

type PostHandler = (params: PostParams) => Promise<unknown>;

const postCalls: PostParams[] = [];
let postHandler: PostHandler | undefined;
const cacheKeyPartsLog: Array<Array<unknown>> = [];

export const __test = {
  reset() {
    cache.clear();
    postCalls.length = 0;
    cacheKeyPartsLog.length = 0;
    postHandler = undefined;
  },
  setPostHandler(handler: PostHandler) {
    postHandler = handler;
  },
  getPostCalls() {
    return [...postCalls];
  },
  getCacheKeyPartsLog() {
    return cacheKeyPartsLog.map(parts => [...parts]);
  },
};

export function buildSearchCacheKey(parts: Array<unknown>): string {
  cacheKeyPartsLog.push(parts);
  return JSON.stringify(parts);
}

export function readCachedSearchPayload(key: string): Record<string, unknown> | undefined {
  return cache.get(key);
}

export function writeCachedSearchPayload(
  key: string,
  payload: Record<string, unknown>,
  _ttlMs: number
): void {
  cache.set(key, payload);
}

export function enablePluginInConfig(config: Record<string, unknown>, pluginId: string) {
  const plugins = (config.plugins as Record<string, unknown> | undefined) ?? {};
  const entries = (plugins.entries as Record<string, unknown> | undefined) ?? {};
  entries[pluginId] = { enabled: true };
  plugins.entries = entries;
  config.plugins = plugins;
  return { config };
}

export function getScopedCredentialValue(
  searchConfig: Record<string, unknown> | undefined,
  providerId: string
): unknown {
  if (!searchConfig) {
    return undefined;
  }
  const providers = searchConfig.providers;
  if (typeof providers !== 'object' || providers === null) {
    return undefined;
  }
  const provider = (providers as Record<string, unknown>)[providerId];
  if (typeof provider !== 'object' || provider === null) {
    return undefined;
  }
  return (provider as Record<string, unknown>).apiKey;
}

export function setScopedCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  providerId: string,
  value: unknown
): void {
  const providers =
    typeof searchConfigTarget.providers === 'object' && searchConfigTarget.providers !== null
      ? (searchConfigTarget.providers as Record<string, unknown>)
      : {};
  const provider =
    typeof providers[providerId] === 'object' && providers[providerId] !== null
      ? (providers[providerId] as Record<string, unknown>)
      : {};
  provider.apiKey = value;
  providers[providerId] = provider;
  searchConfigTarget.providers = providers;
}

export function readStringParam(
  args: Record<string, unknown>,
  key: string,
  options?: { required?: boolean }
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (options?.required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

export function readNumberParam(
  args: Record<string, unknown>,
  key: string,
  options?: { integer?: boolean }
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  if (options?.integer && !Number.isInteger(parsed)) {
    return undefined;
  }
  return parsed;
}

export function parseIsoDateRange(params: {
  rawDateAfter?: string;
  rawDateBefore?: string;
  invalidDateAfterMessage: string;
  invalidDateBeforeMessage: string;
  invalidDateRangeMessage: string;
}): { dateAfter?: string; dateBefore?: string } | { error: string; message: string; docs: string } {
  const { rawDateAfter, rawDateBefore } = params;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (rawDateAfter && !datePattern.test(rawDateAfter)) {
    return {
      error: 'invalid_date_after',
      message: params.invalidDateAfterMessage,
      docs: 'https://docs.openclaw.ai/tools/web',
    };
  }
  if (rawDateBefore && !datePattern.test(rawDateBefore)) {
    return {
      error: 'invalid_date_before',
      message: params.invalidDateBeforeMessage,
      docs: 'https://docs.openclaw.ai/tools/web',
    };
  }
  if (rawDateAfter && rawDateBefore && rawDateAfter > rawDateBefore) {
    return {
      error: 'invalid_date_range',
      message: params.invalidDateRangeMessage,
      docs: 'https://docs.openclaw.ai/tools/web',
    };
  }
  return {
    dateAfter: rawDateAfter,
    dateBefore: rawDateBefore,
  };
}

export function readProviderEnvValue(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveSearchCacheTtlMs(searchConfig?: Record<string, unknown>): number {
  const ttl = searchConfig?.cacheTtlMs;
  return typeof ttl === 'number' ? ttl : 30_000;
}

export function resolveSearchTimeoutSeconds(searchConfig?: Record<string, unknown>): number {
  const timeout = searchConfig?.timeoutSeconds;
  return typeof timeout === 'number' ? timeout : 20;
}

export function resolveSiteName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function wrapWebContent(value: string, source: string): string {
  return `[wrapped:${source}]${value}`;
}

export async function postTrustedWebToolsJson(
  params: PostParams,
  parseResponse: (response: Response) => Promise<unknown>
): Promise<unknown> {
  postCalls.push(params);
  if (!postHandler) {
    throw new Error('postTrustedWebToolsJson called without test handler');
  }
  const payload = await postHandler(params);
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  return parseResponse(response);
}

export type SearchConfigRecord = Record<string, unknown>;
export type WebSearchProviderToolDefinition = {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type WebSearchProviderPlugin = {
  id: string;
  label: string;
  hint: string;
  onboardingScopes?: string[];
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars: string[];
  placeholder: string;
  signupUrl: string;
  docsUrl?: string;
  autoDetectOrder?: number;
  credentialPath: string;
  inactiveSecretPaths?: string[];
  getCredentialValue: (searchConfig?: Record<string, unknown>) => unknown;
  setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => void;
  applySelectionConfig?: (config: Record<string, unknown>) => Record<string, unknown>;
  createTool: (ctx: {
    config?: Record<string, unknown>;
    searchConfig?: Record<string, unknown>;
    runtimeMetadata?: Record<string, unknown>;
  }) => WebSearchProviderToolDefinition | null;
};
