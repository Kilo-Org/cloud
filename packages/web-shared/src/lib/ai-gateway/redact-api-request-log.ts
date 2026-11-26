import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const REDACTED = '[redacted]';

/**
 * Credential patterns in free text. The first three adapt Sentry Relay's built-in `@pemkey`,
 * `@bearer` and `@urlauth` rules (relay-pii/src/regexes.rs): only private keys with key material
 * are redacted, and a Bearer token must look like a token (16+ characters with a digit), so prose
 * such as "Bearer authentication" is kept. Ambiguous matches need the same token shape. Sentry's
 * PII rules (card numbers, IBANs, SSNs, emails, IPs) and its value-based `@password` rule, which
 * drops any whole string that mentions "auth" or "password", are not applied: they would erase the
 * prompts the logs exist for. Every pattern is bounded or stops at a delimiter, so its cost stays
 * linear in the text.
 */
const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Keeps the BEGIN line, any `Proc-Type`-style headers and the END line. Lines may also be
  // separated by an escaped `\n`, as in `.env` files.
  [
    /(-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[ \t]*(?:\r?\n|\\n)?(?:[A-Za-z][A-Za-z-]*:[^\r\n\\]*(?:\r?\n|\\n))*(?:\r?\n|\\n)?)[A-Za-z0-9+/=]{16,}(?:(?:\r?\n|\\n)[A-Za-z0-9+/=]+)*/g,
    `$1${REDACTED}`,
  ],
  // RFC 6750 b64token characters, so a closing quote around the header value is kept.
  [/\b(Bearer[ \t]+)(?=[A-Za-z0-9\-._~+/]*\d)[A-Za-z0-9\-._~+/]{16,}=*/gi, `$1${REDACTED}`],
  [
    /\b((?:[a-z][a-z0-9+.-]{0,31}:)?\/\/)[a-z0-9%_.~-]{1,256}(?::[a-z0-9%_.~-]{0,256})?@/gi,
    `$1${REDACTED}@`,
  ],
  [
    /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:Basic|Digest|Token)[ \t]+)[^\s"'\\]{8,}/gi,
    `$1${REDACTED}`,
  ],
  [
    /([?&#](?:api[-_]?key|key|(?:access|auth|id|private|refresh|session)[-_]?token|token|access[-_]?key|client[-_]?secret|secret|password|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)(?=[^&#\s"'`)\]<>\\]*\d)[^&#\s"'`)\]<>\\]{16,}/gi,
    `$1${REDACTED}`,
  ],
  // Well-known token formats: OpenAI, Anthropic and OpenRouter `sk-` keys, GitHub tokens, AWS
  // access key IDs, Slack tokens and Google API keys.
  [
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
    REDACTED,
  ],
];

/** Base64 attachments, such as images and PDFs, where a token-shaped run is just data. */
function isEncodedAttachment(text: string): boolean {
  return (
    /^data:[^,]{0,200};base64,/.test(text) ||
    (text.length >= 256 && /^[A-Za-z0-9+/=_\-\r\n]+$/.test(text))
  );
}

/** Redacts inside parsed JSON, such as tool call arguments, so the result stays valid JSON. */
function redactSerializedJson(text: string): string | undefined {
  const start = text.trimStart()[0];
  if (start !== '{' && start !== '[') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const redacted = JSON.stringify(redactStrings(parsed));
  return redacted === JSON.stringify(parsed) ? text : redacted;
}

export function redactCredentialsInText(text: string): string {
  if (isEncodedAttachment(text)) return text;
  return (
    redactSerializedJson(text) ??
    TEXT_RULES.reduce(
      (result, [pattern, replacement]) => result.replace(pattern, replacement),
      text
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactStringsInRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, redactStrings(value)])
  );
}

function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactCredentialsInText(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  return isRecord(value) ? redactStringsInRecord(value) : value;
}

function redactFields(record: unknown, fields: readonly string[]): void {
  if (!isRecord(record)) return;
  for (const field of fields) {
    if (record[field] !== undefined && record[field] !== null) record[field] = REDACTED;
  }
}

function forEachRecord(value: unknown, callback: (record: Record<string, unknown>) => void): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (isRecord(item)) callback(item);
  }
}

function redactMcpServerOptions(options: Record<string, unknown>): void {
  redactFields(options, ['authorization']);
  if (isRecord(options.headers)) {
    options.headers = Object.fromEntries(Object.keys(options.headers).map(key => [key, REDACTED]));
  }
}

// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/on-your-data
const AZURE_AUTHENTICATION_FIELDS = [
  'key',
  'access_token',
  'encoded_api_key',
  'connection_string',
  'password',
];

// https://docs.litellm.ai/docs/proxy/clientside_auth and https://docs.litellm.ai/docs/completion/input
const LITELLM_CREDENTIAL_FIELDS = [
  'api_key',
  'aws_secret_access_key',
  'aws_session_token',
  'aws_web_identity_token',
  'azure_ad_token',
  'vertex_credentials',
];

/**
 * Replaces credentials at documented request paths only, so tool inputs and metadata that use
 * names such as `secret` or `cookie` keep their values.
 */
function redactDocumentedCredentials(body: Record<string, unknown>): void {
  // https://platform.openai.com/docs/guides/tools-remote-mcp and OpenRouter's `openrouter:mcp`
  // tool, whose server options sit under `parameters`
  forEachRecord(body.tools, tool => {
    if (tool.type === 'mcp') redactMcpServerOptions(tool);
    else if (tool.type === 'openrouter:mcp' && isRecord(tool.parameters)) {
      redactMcpServerOptions(tool.parameters);
    }
  });
  // https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector
  forEachRecord(body.mcp_servers, server => redactFields(server, ['authorization_token']));
  forEachRecord(body.data_sources, source => {
    if (!isRecord(source.parameters)) return;
    redactFields(source.parameters.authentication, AZURE_AUTHENTICATION_FIELDS);
    if (isRecord(source.parameters.embedding_dependency)) {
      redactFields(
        source.parameters.embedding_dependency.authentication,
        AZURE_AUTHENTICATION_FIELDS
      );
    }
  });
  redactFields(body, LITELLM_CREDENTIAL_FIELDS);
  if (isRecord(body.user_config)) {
    forEachRecord(body.user_config.model_list, model =>
      redactFields(model.litellm_params, LITELLM_CREDENTIAL_FIELDS)
    );
  }

  const providerOptions = body.providerOptions;
  if (!isRecord(providerOptions)) return;
  // https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
  if (isRecord(providerOptions.anthropic)) {
    forEachRecord(providerOptions.anthropic.mcpServers, server =>
      redactFields(server, ['authorizationToken'])
    );
  }
  // https://vercel.com/docs/ai-gateway/byok#request-scoped-byok
  const gateway = providerOptions.gateway;
  if (isRecord(gateway) && isRecord(gateway.byok)) {
    gateway.byok = Object.fromEntries(
      Object.entries(gateway.byok).map(([provider, credentials]) => [
        provider,
        Array.isArray(credentials) ? credentials.map(() => ({ apiKey: REDACTED })) : REDACTED,
      ])
    );
  }
}

/**
 * Copies the request body for the API request log with documented credential fields replaced and
 * credentials in text redacted. Never mutates the request sent upstream.
 */
export function redactApiRequestLogRequest(request: GatewayRequest): Record<string, unknown> {
  // A fresh copy, so the documented fields can be replaced in place.
  const body = redactStringsInRecord({ ...request.body });
  redactDocumentedCredentials(body);
  return body;
}
