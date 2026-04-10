import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  enablePluginInConfig,
  getScopedCredentialValue,
  parseIsoDateRange,
  postTrustedWebToolsJson,
  readCachedSearchPayload,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setScopedCredentialValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  wrapWebContent,
  writeCachedSearchPayload,
} from 'openclaw/plugin-sdk/provider-web-search';

const KILO_EXA_PROVIDER_ID = 'kilo-exa';
const DEFAULT_KILO_API_ORIGIN = 'https://api.kilo.ai';
const EXA_SEARCH_TYPES = ['auto', 'neural', 'fast', 'deep', 'deep-reasoning', 'instant'] as const;
const EXA_FRESHNESS_VALUES = ['day', 'week', 'month', 'year'] as const;
const EXA_MAX_SEARCH_COUNT = 100;

type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];
type ExaFreshness = (typeof EXA_FRESHNESS_VALUES)[number];

type ExaTextContentsOption = boolean | { maxCharacters?: number };
type ExaHighlightsContentsOption =
  | boolean
  | {
      maxCharacters?: number;
      query?: string;
      numSentences?: number;
      highlightsPerUrl?: number;
    };
type ExaSummaryContentsOption = boolean | { query?: string };

type ExaContentsArgs = {
  highlights?: ExaHighlightsContentsOption;
  text?: ExaTextContentsOption;
  summary?: ExaSummaryContentsOption;
};

type ExaSearchResult = {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
  highlightScores?: unknown;
  summary?: unknown;
  text?: unknown;
};

type ErrorPayload = {
  error: string;
  message: string;
  docs: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

function errorPayload(error: string, message: string): ErrorPayload {
  return {
    error,
    message,
    docs: 'https://docs.openclaw.ai/tools/web',
  };
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return isRecord(value) && typeof value.error === 'string' && typeof value.message === 'string';
}

function optionalStringEnum(
  values: readonly string[],
  description: string
): Record<string, unknown> {
  return {
    type: 'string',
    enum: [...values],
    description,
  };
}

function normalizeExaFreshness(value: string | undefined): ExaFreshness | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  return EXA_FRESHNESS_VALUES.find(freshness => freshness === normalized);
}

function resolveExaSearchType(value: string | undefined): ExaSearchType {
  if (!value) {
    return 'auto';
  }
  return EXA_SEARCH_TYPES.find(type => type === value) ?? 'auto';
}

function resolveExaDescription(result: ExaSearchResult): string {
  if (Array.isArray(result.highlights)) {
    const highlightText = result.highlights
      .map(entry => normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join('\n');
    if (highlightText) {
      return highlightText;
    }
  }

  const summary = normalizeOptionalString(result.summary);
  if (summary) {
    return summary;
  }

  return normalizeOptionalString(result.text) ?? '';
}

function normalizeExaResults(payload: unknown): ExaSearchResult[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (!Array.isArray(payload.results)) {
    return [];
  }

  return payload.results.filter((entry): entry is ExaSearchResult => isRecord(entry));
}

function resolveFreshnessStartDate(freshness: ExaFreshness): string {
  const now = new Date();

  if (freshness === 'day') {
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString();
  }
  if (freshness === 'week') {
    now.setUTCDate(now.getUTCDate() - 7);
    return now.toISOString();
  }
  if (freshness === 'month') {
    const currentDay = now.getUTCDate();
    now.setUTCDate(1);
    now.setUTCMonth(now.getUTCMonth() - 1);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
    ).getUTCDate();
    now.setUTCDate(Math.min(currentDay, lastDayOfTargetMonth));
    return now.toISOString();
  }

  now.setUTCFullYear(now.getUTCFullYear() - 1);
  return now.toISOString();
}

function parseKiloApiOrigin(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    return new URL(normalized).origin;
  } catch {
    return undefined;
  }
}

function resolveKiloApiOrigin(): string {
  return (
    parseKiloApiOrigin(process.env.KILO_API_URL) ??
    parseKiloApiOrigin(process.env.KILOCODE_API_BASE_URL) ??
    DEFAULT_KILO_API_ORIGIN
  );
}

function resolveKiloExaSearchEndpoint(): string {
  return `${resolveKiloApiOrigin()}/api/exa/search`;
}

function resolveKiloCodeApiKey(): string | undefined {
  return readProviderEnvValue(['KILOCODE_API_KEY']);
}

function resolveKiloOrganizationId(): string | undefined {
  return normalizeOptionalString(process.env.KILOCODE_ORGANIZATION_ID);
}

function resolveExaSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(EXA_MAX_SEARCH_COUNT, Math.floor(parsed)));
}

function parseExaContents(rawContents: unknown): { value?: ExaContentsArgs } | ErrorPayload {
  if (rawContents === undefined) {
    return { value: undefined };
  }
  if (!isRecord(rawContents)) {
    return errorPayload(
      'invalid_contents',
      'contents must be an object with optional text, highlights, and summary fields.'
    );
  }

  const allowedKeys = new Set(['text', 'highlights', 'summary']);
  for (const key of Object.keys(rawContents)) {
    if (!allowedKeys.has(key)) {
      return errorPayload(
        'invalid_contents',
        `contents has unknown field "${key}". Only "text", "highlights", and "summary" are allowed.`
      );
    }
  }

  const parsed: ExaContentsArgs = {};

  const parseText = (value: unknown): ExaTextContentsOption | ErrorPayload => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (!isRecord(value)) {
      return errorPayload('invalid_contents', 'contents.text must be a boolean or an object.');
    }
    for (const key of Object.keys(value)) {
      if (key !== 'maxCharacters') {
        return errorPayload(
          'invalid_contents',
          `contents.text has unknown field "${key}". Only "maxCharacters" is allowed.`
        );
      }
    }
    if ('maxCharacters' in value && parsePositiveInteger(value.maxCharacters) === undefined) {
      return errorPayload(
        'invalid_contents',
        'contents.text.maxCharacters must be a positive integer.'
      );
    }
    const maxCharacters = parsePositiveInteger(value.maxCharacters);
    return maxCharacters ? { maxCharacters } : {};
  };

  const parseHighlights = (value: unknown): ExaHighlightsContentsOption | ErrorPayload => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (!isRecord(value)) {
      return errorPayload(
        'invalid_contents',
        'contents.highlights must be a boolean or an object.'
      );
    }
    const allowed = new Set(['maxCharacters', 'query', 'numSentences', 'highlightsPerUrl']);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        return errorPayload(
          'invalid_contents',
          `contents.highlights has unknown field "${key}". Allowed fields are "maxCharacters", "query", "numSentences", and "highlightsPerUrl".`
        );
      }
    }
    if ('maxCharacters' in value && parsePositiveInteger(value.maxCharacters) === undefined) {
      return errorPayload(
        'invalid_contents',
        'contents.highlights.maxCharacters must be a positive integer.'
      );
    }
    if ('numSentences' in value && parsePositiveInteger(value.numSentences) === undefined) {
      return errorPayload(
        'invalid_contents',
        'contents.highlights.numSentences must be a positive integer.'
      );
    }
    if ('highlightsPerUrl' in value && parsePositiveInteger(value.highlightsPerUrl) === undefined) {
      return errorPayload(
        'invalid_contents',
        'contents.highlights.highlightsPerUrl must be a positive integer.'
      );
    }
    if ('query' in value && typeof value.query !== 'string') {
      return errorPayload('invalid_contents', 'contents.highlights.query must be a string.');
    }
    const maxCharacters = parsePositiveInteger(value.maxCharacters);
    const numSentences = parsePositiveInteger(value.numSentences);
    const highlightsPerUrl = parsePositiveInteger(value.highlightsPerUrl);
    return {
      ...(maxCharacters ? { maxCharacters } : {}),
      ...(typeof value.query === 'string' ? { query: value.query } : {}),
      ...(numSentences ? { numSentences } : {}),
      ...(highlightsPerUrl ? { highlightsPerUrl } : {}),
    };
  };

  const parseSummary = (value: unknown): ExaSummaryContentsOption | ErrorPayload => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (!isRecord(value)) {
      return errorPayload('invalid_contents', 'contents.summary must be a boolean or an object.');
    }
    for (const key of Object.keys(value)) {
      if (key !== 'query') {
        return errorPayload(
          'invalid_contents',
          `contents.summary has unknown field "${key}". Only "query" is allowed.`
        );
      }
    }
    if ('query' in value && typeof value.query !== 'string') {
      return errorPayload('invalid_contents', 'contents.summary.query must be a string.');
    }
    return typeof value.query === 'string' ? { query: value.query } : {};
  };

  if ('text' in rawContents) {
    const parsedText = parseText(rawContents.text);
    if (isErrorPayload(parsedText)) {
      return parsedText;
    }
    parsed.text = parsedText;
  }
  if ('highlights' in rawContents) {
    const parsedHighlights = parseHighlights(rawContents.highlights);
    if (isErrorPayload(parsedHighlights)) {
      return parsedHighlights;
    }
    parsed.highlights = parsedHighlights;
  }
  if ('summary' in rawContents) {
    const parsedSummary = parseSummary(rawContents.summary);
    if (isErrorPayload(parsedSummary)) {
      return parsedSummary;
    }
    parsed.summary = parsedSummary;
  }

  return { value: parsed };
}

function createExaSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'Search query string.',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (1-100, subject to Exa search-type limits).',
        minimum: 1,
        maximum: EXA_MAX_SEARCH_COUNT,
      },
      freshness: optionalStringEnum(
        EXA_FRESHNESS_VALUES,
        'Filter by time: "day", "week", "month", or "year".'
      ),
      date_after: {
        type: 'string',
        description: 'Only results published after this date (YYYY-MM-DD).',
      },
      date_before: {
        type: 'string',
        description: 'Only results published before this date (YYYY-MM-DD).',
      },
      type: optionalStringEnum(
        EXA_SEARCH_TYPES,
        'Exa search mode: "auto", "neural", "fast", "deep", "deep-reasoning", or "instant".'
      ),
      contents: {
        type: 'object',
        additionalProperties: false,
        properties: {
          highlights: {
            description:
              'Highlights config: true, or an object with maxCharacters, query, numSentences, or highlightsPerUrl.',
            oneOf: [
              { type: 'boolean' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  maxCharacters: { type: 'number', minimum: 1 },
                  query: { type: 'string' },
                  numSentences: { type: 'number', minimum: 1 },
                  highlightsPerUrl: { type: 'number', minimum: 1 },
                },
              },
            ],
          },
          text: {
            description: 'Text config: true, or an object with maxCharacters.',
            oneOf: [
              { type: 'boolean' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  maxCharacters: { type: 'number', minimum: 1 },
                },
              },
            ],
          },
          summary: {
            description: 'Summary config: true, or an object with query.',
            oneOf: [
              { type: 'boolean' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  query: { type: 'string' },
                },
              },
            ],
          },
        },
      },
    },
    required: ['query'],
  };
}

function missingKiloApiKeyPayload(): ErrorPayload {
  return errorPayload(
    'missing_kilocode_api_key',
    'web_search (kilo-exa) needs KILOCODE_API_KEY in the Gateway environment.'
  );
}

async function runKiloExaSearch(params: {
  kiloCodeApiKey: string;
  query: string;
  count: number;
  freshness?: ExaFreshness;
  dateAfter?: string;
  dateBefore?: string;
  type: ExaSearchType;
  contents?: ExaContentsArgs;
  timeoutSeconds: number;
}): Promise<ExaSearchResult[]> {
  const body: Record<string, unknown> = {
    query: params.query,
    numResults: params.count,
    type: params.type,
    contents: params.contents ?? { highlights: true },
  };

  if (params.dateAfter) {
    body.startPublishedDate = params.dateAfter;
  } else if (params.freshness) {
    body.startPublishedDate = resolveFreshnessStartDate(params.freshness);
  }
  if (params.dateBefore) {
    body.endPublishedDate = params.dateBefore;
  }

  const organizationId = resolveKiloOrganizationId();
  const extraHeaders = organizationId ? { 'X-KiloCode-OrganizationId': organizationId } : undefined;

  return postTrustedWebToolsJson(
    {
      url: resolveKiloExaSearchEndpoint(),
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.kiloCodeApiKey,
      body,
      errorLabel: 'Kilo Exa proxy',
      ...(extraHeaders ? { extraHeaders } : {}),
    },
    async response => {
      try {
        return normalizeExaResults(await response.json());
      } catch (error) {
        throw new Error(`Kilo Exa proxy returned invalid JSON: ${String(error)}`, {
          cause: error,
        });
      }
    }
  );
}

function isSearchConfigRecord(value: unknown): value is SearchConfigRecord {
  return isRecord(value);
}

function createKiloExaToolDefinition(
  searchConfig?: SearchConfigRecord
): WebSearchProviderToolDefinition {
  return {
    description:
      'Search the web using Exa through Kilo proxying. Supports neural or keyword search, publication date filters, and optional highlights or text extraction.',
    parameters: createExaSchema(),
    execute: async args => {
      const kiloCodeApiKey = resolveKiloCodeApiKey();
      if (!kiloCodeApiKey) {
        return missingKiloApiKeyPayload();
      }

      const query = readStringParam(args, 'query', { required: true });
      const type = resolveExaSearchType(readStringParam(args, 'type'));
      const count =
        readNumberParam(args, 'count', { integer: true }) ?? searchConfig?.maxResults ?? undefined;
      const rawFreshness = readStringParam(args, 'freshness');
      const freshness = normalizeExaFreshness(rawFreshness);
      if (rawFreshness && !freshness) {
        return errorPayload(
          'invalid_freshness',
          'freshness must be one of "day", "week", "month", or "year".'
        );
      }

      const rawDateAfter = readStringParam(args, 'date_after');
      const rawDateBefore = readStringParam(args, 'date_before');
      if (freshness && (rawDateAfter || rawDateBefore)) {
        return errorPayload(
          'conflicting_time_filters',
          'freshness cannot be combined with date_after or date_before. Use one time-filter mode.'
        );
      }

      const parsedDateRange = parseIsoDateRange({
        rawDateAfter,
        rawDateBefore,
        invalidDateAfterMessage: 'date_after must be YYYY-MM-DD format.',
        invalidDateBeforeMessage: 'date_before must be YYYY-MM-DD format.',
        invalidDateRangeMessage: 'date_after must be earlier than or equal to date_before.',
      });
      if ('error' in parsedDateRange) {
        return parsedDateRange;
      }

      const parsedContents = parseExaContents(args.contents);
      if ('error' in parsedContents) {
        return parsedContents;
      }
      const contents =
        parsedContents.value && Object.keys(parsedContents.value).length > 0
          ? parsedContents.value
          : undefined;
      const contentsCacheToken = contents ? JSON.stringify(contents) : undefined;

      const normalizedCount = resolveExaSearchCount(count, DEFAULT_SEARCH_COUNT);
      const cacheKey = buildSearchCacheKey([
        KILO_EXA_PROVIDER_ID,
        type,
        query,
        normalizedCount,
        parsedDateRange.dateAfter,
        parsedDateRange.dateBefore,
        freshness,
        contentsCacheToken,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const startedAt = Date.now();
      const results = await runKiloExaSearch({
        kiloCodeApiKey,
        query,
        count: normalizedCount,
        freshness,
        dateAfter: parsedDateRange.dateAfter,
        dateBefore: parsedDateRange.dateBefore,
        type,
        contents,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });

      const payload = {
        query,
        provider: KILO_EXA_PROVIDER_ID,
        count: results.length,
        tookMs: Date.now() - startedAt,
        externalContent: {
          untrusted: true,
          source: 'web_search',
          provider: KILO_EXA_PROVIDER_ID,
          wrapped: true,
        },
        results: results.map(entry => {
          const title = typeof entry.title === 'string' ? entry.title : '';
          const url = typeof entry.url === 'string' ? entry.url : '';
          const description = resolveExaDescription(entry);
          const summary = normalizeOptionalString(entry.summary) ?? '';
          const highlightScores = Array.isArray(entry.highlightScores)
            ? entry.highlightScores.filter(
                (score): score is number => typeof score === 'number' && Number.isFinite(score)
              )
            : [];
          const published =
            typeof entry.publishedDate === 'string' && entry.publishedDate
              ? entry.publishedDate
              : undefined;

          return {
            title: title ? wrapWebContent(title, 'web_search') : '',
            url,
            description: description ? wrapWebContent(description, 'web_search') : '',
            published,
            siteName: resolveSiteName(url) || undefined,
            ...(summary ? { summary: wrapWebContent(summary, 'web_search') } : {}),
            ...(highlightScores.length > 0 ? { highlightScores } : {}),
          };
        }),
      };

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createKiloExaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: KILO_EXA_PROVIDER_ID,
    label: 'Exa Search (Kilo)',
    hint: 'Exa search on Kilo tokens with date filters and content extraction',
    onboardingScopes: ['text-inference'],
    requiresCredential: false,
    credentialLabel: 'Kilo API key',
    envVars: ['KILOCODE_API_KEY'],
    placeholder: '(managed by KiloClaw)',
    signupUrl: 'https://kilo.ai/',
    docsUrl: 'https://docs.openclaw.ai/tools/web',
    autoDetectOrder: 55,
    credentialPath: '',
    inactiveSecretPaths: [],
    getCredentialValue: searchConfig =>
      getScopedCredentialValue(searchConfig, KILO_EXA_PROVIDER_ID),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, KILO_EXA_PROVIDER_ID, value),
    applySelectionConfig: config => enablePluginInConfig(config, 'kiloclaw-customizer').config,
    createTool: ctx =>
      createKiloExaToolDefinition(
        isSearchConfigRecord(ctx.searchConfig) ? ctx.searchConfig : undefined
      ),
  };
}

export const __testing = {
  normalizeExaResults,
  normalizeExaFreshness,
  parseExaContents,
  resolveExaDescription,
  resolveExaSearchCount,
  resolveFreshnessStartDate,
  resolveKiloApiOrigin,
} as const;
