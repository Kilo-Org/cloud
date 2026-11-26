import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const REDACTED = '[redacted]';

/**
 * Keys, compared case-insensitively with `-` and `_` removed, whose non-object values are
 * credentials wherever they appear in a request body. Covers the MCP tool `authorization` (OpenAI
 * and OpenRouter Responses), Anthropic's `mcp_servers[].authorization_token`, the AI SDK's
 * `mcpServers[].authorizationToken`, Azure On Your Data `authentication` options, LiteLLM's
 * per-request provider credentials, and Vercel BYOK credential fields. Object values are walked
 * instead, so a JSON schema property named `password` is kept.
 */
const CREDENTIAL_KEYS = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'apitoken',
  'authorization',
  'authorizationtoken',
  'authtoken',
  'awsbearertokenbedrock',
  'awssecretaccesskey',
  'awssessiontoken',
  'awswebidentitytoken',
  'azureadtoken',
  'bearertoken',
  'clientsecret',
  'connectionstring',
  'cookie',
  'encodedapikey',
  'idtoken',
  'ocpapimsubscriptionkey',
  'passwd',
  'password',
  'privatekey',
  'privatetoken',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'secretaccesskey',
  'secretkey',
  'sessiontoken',
  'vertexcredentials',
  'xapikey',
  'xgoogapikey',
]);

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase().replaceAll(/[-_]/g, ''));
}

/**
 * Credential patterns in free text. The first three adapt Sentry Relay's built-in `@pemkey`,
 * `@bearer` and `@urlauth` rules (relay-pii/src/regexes.rs): PEM public keys are kept, an
 * unterminated private key is still redacted, and a Bearer token must contain a digit or
 * punctuation so prose such as "Bearer of bad news" is kept. Sentry's PII rules (card numbers,
 * IBANs, SSNs, emails, IPs) and its value-based `@password` rule, which drops any whole string
 * that mentions "auth" or "password", are not applied: they would erase the prompts the logs exist
 * for. Every pattern is bounded or stops at a delimiter, so its cost stays linear in the text.
 */
const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Stops at the next `-----`, which is the END line of a complete key.
  [
    /(-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----)[^-]*(?:-(?!----)[^-]*)*/g,
    `$1${REDACTED}`,
  ],
  // RFC 6750 b64token characters, so a closing quote around the header value is kept.
  [
    /\b(Bearer[ \t]+)(?=[A-Za-z0-9\-._~+/]*[0-9\-._~+/])[A-Za-z0-9\-._~+/]{8,}=*/gi,
    `$1${REDACTED}`,
  ],
  [
    /\b((?:[a-z][a-z0-9+.-]{0,31}:)?\/\/)[a-z0-9%_.~-]{1,256}(?::[a-z0-9%_.~-]{0,256})?@/gi,
    `$1${REDACTED}@`,
  ],
  [
    /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:Basic|Digest|Token)[ \t]+)[^\s"'\\]+/gi,
    `$1${REDACTED}`,
  ],
  [
    /([?&#](?:api[-_]?key|key|(?:access|auth|id|private|refresh|session)[-_]?token|token|access[-_]?key|client[-_]?secret|secret|password|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^&#\s"'`)\]<>\\]+/gi,
    `$1${REDACTED}`,
  ],
  // Well-known token formats: OpenAI, Anthropic and OpenRouter `sk-` keys, GitHub tokens, AWS
  // access key IDs, Slack tokens and Google API keys.
  [
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
    REDACTED,
  ],
];

export function redactCredentialsInText(text: string): string {
  return TEXT_RULES.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactAllValues(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map(key => [key, REDACTED]));
}

/**
 * `credentialFields` names extra fields of this object that are credentials only in this
 * position, such as the MCP tool `headers` map or the Azure On Your Data `authentication.key`.
 */
function redactRecord(
  record: Record<string, unknown>,
  key: string | undefined,
  credentialFields: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([childKey, child]) => {
      if (
        child !== null &&
        !isRecord(child) &&
        (isCredentialKey(childKey) || credentialFields.has(childKey))
      ) {
        return [childKey, REDACTED];
      }
      if (childKey === 'headers' && credentialFields.has('headers') && isRecord(child)) {
        return [childKey, redactAllValues(child)];
      }
      // https://vercel.com/docs/ai-gateway/byok#request-scoped-byok
      if (childKey === 'byok' && key === 'gateway' && isRecord(child)) {
        return [
          childKey,
          Object.fromEntries(
            Object.entries(child).map(([provider, credentials]) => [
              provider,
              Array.isArray(credentials) ? credentials.map(() => ({ apiKey: REDACTED })) : REDACTED,
            ])
          ),
        ];
      }
      return [childKey, redactValue(child, childKey, record)];
    })
  );
}

const NO_FIELDS: ReadonlySet<string> = new Set();
const MCP_TOOL_FIELDS: ReadonlySet<string> = new Set(['headers']);
const AUTHENTICATION_FIELDS: ReadonlySet<string> = new Set(['key']);

function redactValue(
  value: unknown,
  key: string | undefined,
  parent: Record<string, unknown> | undefined
): unknown {
  if (typeof value === 'string') return redactCredentialsInText(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, undefined, undefined));
  if (!isRecord(value)) return value;

  // https://platform.openai.com/docs/guides/tools-remote-mcp and OpenRouter's
  // `openrouter:mcp` tool, whose server options sit under `parameters`
  const isMcpTool =
    value.type === 'mcp' || (key === 'parameters' && parent?.type === 'openrouter:mcp');
  // https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/on-your-data
  const isAuthenticationOptions = key === 'authentication';
  return redactRecord(
    value,
    key,
    isMcpTool ? MCP_TOOL_FIELDS : isAuthenticationOptions ? AUTHENTICATION_FIELDS : NO_FIELDS
  );
}

/**
 * Copies the request body for the API request log with known credential fields replaced and
 * credentials in text redacted. Never mutates the request sent upstream.
 */
export function redactApiRequestLogRequest(request: GatewayRequest): Record<string, unknown> {
  return redactRecord({ ...request.body }, undefined, NO_FIELDS);
}
