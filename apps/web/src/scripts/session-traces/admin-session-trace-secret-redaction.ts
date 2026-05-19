import { createHmac } from 'node:crypto';
import { requirePseudonymKey } from './admin-session-trace-pseudonymization';

const REDACTED_SECRET_PREFIX = '[REDACTED_SECRET:v1:';
const REDACTED_SECRET_PATTERN = /^\[REDACTED_SECRET:v1:[a-z0-9-]+:hmac-sha256:[A-Za-z0-9_-]{43}\]$/;
const REDACTED_SECRET_INPUT_NAMESPACE = 'admin-session-trace-secret-redaction:v1';
const PEM_PRIVATE_KEY_PATTERN =
  /(-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----)([\s\S]*?)(-----END \2-----)/g;
const PROVIDER_BEARER_CONTEXT_RADIUS = 512;
const AUTHORIZATION_BEARER_TOKEN_PATTERN =
  /\b(Authorization[ \t]*:[ \t]*Bearer[ \t]+)([A-Za-z0-9][A-Za-z0-9._~+/-]{19,}=*)(?![A-Za-z0-9._~+/-=])/gi;
const OBVIOUS_BEARER_PLACEHOLDER_PATTERN = /^(?:YOUR|REPLACE|EXAMPLE|DUMMY)(?:[_-][A-Z0-9]+)+$/;

type JsonObject = Record<string, unknown>;

type RedactionRule = {
  category: string;
  pattern: RegExp;
};

type ProviderBearerRule = {
  category: string;
  contextPattern: RegExp;
};

const PROVIDER_BEARER_RULES: ProviderBearerRule[] = [
  {
    category: 'meta-graph-bearer-token',
    contextPattern: /(?:^|[^A-Za-z0-9.-])graph\.(?:facebook|instagram)\.com(?=$|[^A-Za-z0-9.-])/i,
  },
  {
    category: 'supabase-bearer-token',
    contextPattern: /(?:^|[^A-Za-z0-9.-])(?:[a-z0-9-]+\.)+supabase\.co(?=$|[^A-Za-z0-9.-])/i,
  },
  {
    category: 'github-api-bearer-token',
    contextPattern: /(?:^|[^A-Za-z0-9.-])api\.github\.com(?=$|[^A-Za-z0-9.-])/i,
  },
];

const HIGH_CONFIDENCE_SECRET_RULES: RedactionRule[] = [
  {
    category: 'anthropic-secret-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    category: 'openai-secret-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    category: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    category: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    category: 'huggingface-token',
    pattern: /\bhf_[A-Za-z0-9]{20,}\b/g,
  },
  {
    category: 'slack-token',
    pattern: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    category: 'stripe-live-secret',
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  },
  {
    category: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    category: 'npm-access-token',
    pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g,
  },
  {
    category: 'jwt-like-token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

export type SecretRedactionStats = {
  replacementsByCategory: Record<string, number>;
  totalReplacements: number;
};

export type SecretRedactionResult<T> = {
  value: T;
  changed: boolean;
  stats: SecretRedactionStats;
};

export function redactHighConfidenceSecrets<T>(value: T, key: string): SecretRedactionResult<T> {
  requirePseudonymKey(key, 'the provided secret redaction key');
  const stats = createEmptyStats();
  const redacted = redactValue(value, key, stats);
  return {
    value: redacted.value as T,
    changed: redacted.changed,
    stats,
  };
}

export function isRedactedSecretToken(value: string): boolean {
  return REDACTED_SECRET_PATTERN.test(value);
}

function redactValue(
  value: unknown,
  key: string,
  stats: SecretRedactionStats
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const result = redactString(value, key, stats);
    return { value: result.value, changed: result.changed };
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index++) {
      const result = redactValue(value[index], key, stats);
      if (result.changed) {
        copy = copy ?? [...value];
        copy[index] = result.value;
      }
    }
    return { value: copy ?? value, changed: copy !== null };
  }
  if (isJsonObject(value)) {
    let copy: JsonObject | null = null;
    for (const [field, nestedValue] of Object.entries(value)) {
      const result = redactValue(nestedValue, key, stats);
      if (result.changed) {
        copy = copy ?? { ...value };
        copy[field] = result.value;
      }
    }
    return { value: copy ?? value, changed: copy !== null };
  }
  return { value, changed: false };
}

function redactString(
  input: string,
  key: string,
  stats: SecretRedactionStats
): { value: string; changed: boolean } {
  if (!input || isRedactedSecretToken(input)) {
    return { value: input, changed: false };
  }

  let changed = false;
  let output = input.replace(
    PEM_PRIVATE_KEY_PATTERN,
    (block, beginLine: string, privateKeyLabel: string, body: string, endLine: string) => {
      if (body.includes(REDACTED_SECRET_PREFIX)) {
        return block;
      }
      changed = true;
      const category = normalizePemCategory(privateKeyLabel);
      increment(stats, category);
      const placeholder = createPlaceholder(block, category, key);
      return `${beginLine}\n${placeholder}\n${endLine}`;
    }
  );

  for (const rule of HIGH_CONFIDENCE_SECRET_RULES) {
    output = output.replace(rule.pattern, match => {
      if (isRedactedSecretToken(match)) {
        return match;
      }
      changed = true;
      increment(stats, rule.category);
      return createPlaceholder(match, rule.category, key);
    });
  }

  const bearerResult = redactProviderAnchoredBearerTokens(output, key, stats);
  output = bearerResult.value;
  changed = changed || bearerResult.changed;

  return { value: output, changed };
}

function redactProviderAnchoredBearerTokens(
  input: string,
  key: string,
  stats: SecretRedactionStats
): { value: string; changed: boolean } {
  let changed = false;
  const value = input.replace(
    AUTHORIZATION_BEARER_TOKEN_PATTERN,
    (match: string, authorizationPrefix: string, token: string, offset: number, source: string) => {
      if (isObviousBearerPlaceholder(token)) {
        return match;
      }
      const context = source.slice(
        Math.max(0, offset - PROVIDER_BEARER_CONTEXT_RADIUS),
        Math.min(source.length, offset + match.length + PROVIDER_BEARER_CONTEXT_RADIUS)
      );
      const providerRule = PROVIDER_BEARER_RULES.find(rule => rule.contextPattern.test(context));
      if (!providerRule) {
        return match;
      }
      changed = true;
      increment(stats, providerRule.category);
      return `${authorizationPrefix}${createPlaceholder(token, providerRule.category, key)}`;
    }
  );
  return { value, changed };
}

function isObviousBearerPlaceholder(token: string): boolean {
  return (
    isRedactedSecretToken(token) ||
    token.includes('...') ||
    OBVIOUS_BEARER_PLACEHOLDER_PATTERN.test(token)
  );
}

function normalizePemCategory(privateKeyLabel: string): string {
  const label = privateKeyLabel.trim().toLowerCase().replaceAll(/\s+/g, '-');
  return `pem-${label}`;
}

function createPlaceholder(secret: string, category: string, key: string): string {
  const digest = createHmac('sha256', key)
    .update(`${REDACTED_SECRET_INPUT_NAMESPACE}:${category}\0${secret}`, 'utf8')
    .digest('base64url');
  return `[REDACTED_SECRET:v1:${category}:hmac-sha256:${digest}]`;
}

function createEmptyStats(): SecretRedactionStats {
  return {
    replacementsByCategory: {},
    totalReplacements: 0,
  };
}

function increment(stats: SecretRedactionStats, category: string): void {
  stats.replacementsByCategory[category] = (stats.replacementsByCategory[category] ?? 0) + 1;
  stats.totalReplacements++;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
