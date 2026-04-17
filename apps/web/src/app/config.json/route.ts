import { NextResponse } from 'next/server';

/**
 * Serves the Kilo CLI config JSON Schema at `app.kilo.ai/config.json`.
 *
 * Fetches the upstream opencode schema at request time and merges Kilo-specific
 * additions/overrides on top. Keep the extras below in sync with the zod schema
 * in packages/opencode/src/config/config.ts in the kilocode repo (grep for
 * `kilocode_change` markers).
 *
 * If this list drifts from the zod schema, users of `$schema: https://app.kilo.ai/config.json`
 * will see spurious "unknown property" warnings for Kilo-only keys.
 */

const UPSTREAM = 'https://opencode.ai/config.json';
const MODEL_REF = 'https://models.dev/model-schema.json#/$defs/Model';
const CACHE_SECONDS = 60 * 60; // 1 hour

const nullableModel = {
  anyOf: [{ $ref: MODEL_REF, type: 'string' }, { type: 'null' }],
};

const agentConfigExtras = {
  ref: 'AgentConfig',
  type: 'object',
  properties: { model: nullableModel },
  additionalProperties: {},
} as const;

const kiloExtras = {
  top: {
    model: {
      description: 'Model to use in the format of provider/model, eg anthropic/claude-2',
      ...nullableModel,
    },
    small_model: {
      description:
        'Small model to use for tasks like title generation in the format of provider/model',
      ...nullableModel,
    },
    remote_control: {
      description:
        'Enable remote control of sessions via Kilo Cloud. Equivalent to running /remote on startup.',
      type: 'boolean',
    },
    commit_message: {
      description: 'Configuration for AI-generated commit messages',
      type: 'object',
      properties: {
        prompt: {
          description:
            'Custom system prompt for AI commit message generation. When set, replaces the default conventional commits prompt entirely.',
          type: 'string',
        },
      },
      additionalProperties: false,
    },
  },
  agents: {
    ask: agentConfigExtras,
    debug: agentConfigExtras,
    orchestrator: agentConfigExtras,
  },
  experimental: {
    codebase_search: {
      description: 'Enable AI-powered codebase search',
      type: 'boolean',
    },
    openTelemetry: {
      description: 'Enable telemetry. Set to false to opt-out.',
      default: true,
      type: 'boolean',
    },
  },
} as const;

export type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function merge(schema: Schema): Schema {
  const properties = isObject(schema.properties) ? { ...schema.properties } : {};
  Object.assign(properties, kiloExtras.top);

  const agent = isObject(properties.agent) ? { ...properties.agent } : {};
  agent.properties = {
    ...(isObject(agent.properties) ? agent.properties : {}),
    ...kiloExtras.agents,
  };
  properties.agent = agent;

  const experimental = isObject(properties.experimental) ? { ...properties.experimental } : {};
  experimental.properties = {
    ...(isObject(experimental.properties) ? experimental.properties : {}),
    ...kiloExtras.experimental,
  };
  properties.experimental = experimental;

  return { ...schema, properties };
}

export async function GET() {
  const res = await fetch(UPSTREAM, { next: { revalidate: CACHE_SECONDS } });
  if (!res.ok) {
    return NextResponse.json(
      { error: `upstream ${UPSTREAM} returned ${res.status}` },
      { status: 502 }
    );
  }
  const upstream = (await res.json()) as Schema;
  const merged = merge(upstream);

  return NextResponse.json(merged, {
    headers: {
      'cache-control': `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`,
      'access-control-allow-origin': '*',
    },
  });
}
