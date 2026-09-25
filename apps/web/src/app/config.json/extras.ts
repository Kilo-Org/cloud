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
 *        - Permission key: `permissions`
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
    auto_expand_history: {
      description: 'Automatically expand command history when searching',
      type: 'boolean',
    },
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
    auto_collapse_reasoning: {
      description:
        "@deprecated Use 'reasoning_display' field instead. Automatically collapse reasoning blocks after the agent finishes writing them",
      type: 'boolean',
    },
    reasoning_display: {
      description: 'Controls how reasoning blocks are displayed in the VS Code chat UI',
      type: 'string',
      enum: ['expanded', 'preview', 'headline'],
    },
    terminal_command_display: {
      description:
        'Controls whether terminal command blocks are expanded or collapsed by default in the VS Code chat UI',
      type: 'string',
      enum: ['expanded', 'collapsed'],
    },
    code_edit_display: {
      description:
        'Controls whether code edit and diff blocks are expanded or collapsed by default in the VS Code chat UI',
      type: 'string',
      enum: ['expanded', 'collapsed'],
    },
    hide_prompt_training_models: {
      description: 'Hide Kilo Gateway models that may train on your prompts from model listings',
      type: 'boolean',
    },
    web_search: {
      description: 'Make web search available to models from all providers (default: false)',
      type: 'boolean',
      default: false,
    },
    privacy_mode: {
      description:
        'Blur personally identifiable information (account email, balance, team name, etc.) in the TUI and require confirmation before showing profile details',
      type: 'boolean',
    },
    require_approval_for_config_edits: {
      description:
        'Require extra approval before the agent edits protected Kilo config files (defaults to true). Global config supplies the fallback and governs global config directories and protected config targets outside the project. Project config can override this only within its project boundary, including re-enabling protection when globally disabled. Disabling this does not bypass other permission rules or independent safeguards.',
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
    retention: {
      // Effect Schema models maxAgeDays as number|'NaN'|'Infinity'|'-Infinity',
      // but JSON config can only carry plain numbers, so the editor schema
      // accepts number only.
      description:
        'Machine-wide session retention. Evaluated by the backend; clients only trigger runs.',
      type: 'object',
      properties: {
        enabled: {
          description:
            'Enable automatic deletion of old sessions across all projects and every Kilo client on this machine. Defaults to false; deletion is permanent.',
          type: 'boolean',
        },
        maxAgeDays: {
          description:
            'Days a session is kept before retention deletes it. Defaults to 30, minimum 1.',
          type: 'number',
          minimum: 1,
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
  permissions: {
    notebook_read: { $ref: '#/$defs/PermissionRuleConfig' },
    notebook_edit: { $ref: '#/$defs/PermissionRuleConfig' },
    notebook_execute: { $ref: '#/$defs/PermissionRuleConfig' },
  },
  experimental: {
    agent_requirements: {
      description:
        'Require declared agent skills, MCPs, and VS Code extensions before VS Code prompts can run',
      type: 'boolean',
    },
    native_notebook_tools: {
      description: 'Enable native tools for reading, editing, and executing VS Code notebooks',
      type: 'boolean',
    },
    openTelemetry: {
      description: 'Enable telemetry. Set to false to opt-out.',
      default: true,
      type: 'boolean',
    },
  },
} as const;
