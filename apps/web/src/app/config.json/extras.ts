/**
 * Kilo-specific additions and overrides for the CLI config JSON Schema.
 *
 * Keep these entries in sync with the zod schema in
 * packages/opencode/src/config/config.ts in the kilocode repo (grep for
 * `kilocode_change` markers). If this list drifts from the zod schema, users
 * of `$schema: https://app.kilo.ai/config.json` will see spurious
 * "unknown property" warnings for Kilo-only keys.
 *
 * To add a new key:
 *   1. Add the zod field with a `kilocode_change` marker in the CLI repo.
 *   2. Run `bun --bun packages/opencode/script/schema.ts /tmp/kilo.json` in
 *      the CLI repo, then `jq '.properties.<new_key>' /tmp/kilo.json` to get
 *      the exact JSON schema shape.
 *   3. Paste that shape into the right bucket below:
 *        - Top-level: `top`
 *        - New primary agent: `agents`
 *        - Under `experimental`: `experimental`
 *        - Anywhere else nested: add a new bucket here AND extend the merge
 *          logic in `./route.ts` to overlay that section.
 *   4. Add an assertion to `apps/web/src/tests/cli-config-schema.test.ts`.
 */

const MODEL_REF = 'https://models.dev/model-schema.json#/$defs/Model';

const nullableModel = {
  anyOf: [{ $ref: MODEL_REF, type: 'string' }, { type: 'null' }],
};

const agentConfig = {
  ref: 'AgentConfig',
  type: 'object',
  properties: { model: nullableModel },
  additionalProperties: {},
} as const;

export const kiloExtras = {
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
    ask: agentConfig,
    debug: agentConfig,
    orchestrator: agentConfig,
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
