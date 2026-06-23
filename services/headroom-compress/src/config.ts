export type ModelLimits = {
  contextLimits: Record<string, number>;
};

export type HeadroomRuntimeConfig = {
  instanceCount: number;
  modelAllowlist: Set<string>;
  modelLimits: ModelLimits;
  maxBodyBytes: number;
  maxMessages: number;
  maxContentChars: number;
  maxTokenBudget: number;
  containerRequestTimeoutMs: number;
};

type ConfigEnv = Pick<
  Env,
  | 'HEADROOM_INSTANCE_COUNT'
  | 'HEADROOM_MODEL_ALLOWLIST'
  | 'HEADROOM_MODEL_LIMITS'
  | 'HEADROOM_MAX_BODY_BYTES'
  | 'HEADROOM_MAX_MESSAGES'
  | 'HEADROOM_MAX_CONTENT_CHARS'
  | 'HEADROOM_MAX_TOKEN_BUDGET'
  | 'HEADROOM_CONTAINER_REQUEST_TIMEOUT_MS'
>;

export class ConfigError extends Error {}

export function loadConfig(env: ConfigEnv): HeadroomRuntimeConfig {
  const modelAllowlist = parseCsvSet(env.HEADROOM_MODEL_ALLOWLIST);
  const modelLimits = parseModelLimits(env.HEADROOM_MODEL_LIMITS);
  if (modelAllowlist.size === 0) {
    throw new ConfigError('HEADROOM_MODEL_ALLOWLIST must contain at least one model');
  }
  for (const model of modelAllowlist) {
    if (!Number.isInteger(modelLimits.contextLimits[model])) {
      throw new ConfigError(`HEADROOM_MODEL_LIMITS missing context limit for ${model}`);
    }
  }

  return {
    instanceCount: parsePositiveInt(env.HEADROOM_INSTANCE_COUNT, 'HEADROOM_INSTANCE_COUNT'),
    modelAllowlist,
    modelLimits,
    maxBodyBytes: parsePositiveInt(env.HEADROOM_MAX_BODY_BYTES, 'HEADROOM_MAX_BODY_BYTES'),
    maxMessages: parsePositiveInt(env.HEADROOM_MAX_MESSAGES, 'HEADROOM_MAX_MESSAGES'),
    maxContentChars: parsePositiveInt(env.HEADROOM_MAX_CONTENT_CHARS, 'HEADROOM_MAX_CONTENT_CHARS'),
    maxTokenBudget: parsePositiveInt(env.HEADROOM_MAX_TOKEN_BUDGET, 'HEADROOM_MAX_TOKEN_BUDGET'),
    containerRequestTimeoutMs: parsePositiveInt(
      env.HEADROOM_CONTAINER_REQUEST_TIMEOUT_MS,
      'HEADROOM_CONTAINER_REQUEST_TIMEOUT_MS'
    ),
  };
}

function parseCsvSet(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0)
  );
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseModelLimits(value: string): ModelLimits {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || !isRecord(parsed.context_limits)) {
    throw new ConfigError('HEADROOM_MODEL_LIMITS must include context_limits');
  }

  const contextLimits: Record<string, number> = {};
  for (const [model, limit] of Object.entries(parsed.context_limits)) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      throw new ConfigError(`HEADROOM_MODEL_LIMITS has invalid context limit for ${model}`);
    }
    contextLimits[model] = limit;
  }
  return { contextLimits };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
