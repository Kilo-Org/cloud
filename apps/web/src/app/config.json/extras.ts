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

const hookGroups = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      matcher: {
        description:
          'Tool names to match: "*" or omitted matches all tools, "edit|write" matches exact names, anything else is a regular expression. Kilo tool ids and their Claude Code names (e.g. Edit, Bash) both match.',
        type: 'string',
      },
      hooks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['command'] },
            command: {
              description:
                'Command to run. Without args it runs through the shell; with args it is the program to spawn directly. It receives the hook input as JSON on stdin.',
              type: 'string',
            },
            args: {
              description:
                'Arguments for exec form: the command is spawned directly with these arguments, without a shell.',
              type: 'array',
              items: { type: 'string' },
            },
            timeout: {
              description:
                'Timeout in seconds (default: 60). A hook that times out does not block the tool call.',
              type: 'integer',
              exclusiveMinimum: 0,
            },
            onFailure: {
              description:
                'Set to "block" so a PreToolUse hook that fails (timeout, crash, unexpected exit code) blocks the tool call instead of letting it run.',
              type: 'string',
              enum: ['block'],
            },
          },
          required: ['type', 'command'],
          additionalProperties: false,
        },
      },
    },
    required: ['hooks'],
    additionalProperties: false,
  },
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
    memory_model: {
      description:
        'Model for automatic project memory saves in the format of provider/model. If unset or unavailable, memory uses the session model.',
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
    hooks: {
      description:
        'Shell command hooks run around agent tool calls, compatible with Claude Code hooks. Only read from global, managed, or organization config; project config hooks are ignored.',
      type: 'object',
      properties: {
        PreToolUse: {
          description:
            'Run before a tool call. Exit code 2 (or a JSON deny decision) blocks the call.',
          ...hookGroups,
        },
        PostToolUse: {
          description:
            'Run after a tool call succeeds. Exit code 2 stderr (or a JSON block reason / additionalContext) is shown to the model.',
          ...hookGroups,
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
    glob_include_ignored: {
      description:
        'Folders or files, as gitignore-style patterns relative to the workspace root, that the glob tool should search even when they are ignored (for example by .gitignore) or hidden. Patterns without a slash match folders at any depth; list a file inside an ignored folder by its path (for example build/report.json). Ignored or hidden folders nested inside a listed folder stay skipped.',
      type: 'array',
      items: { type: 'string' },
    },
    openTelemetry: {
      description: 'Enable telemetry. Set to false to opt-out.',
      default: true,
      type: 'boolean',
    },
  },
} as const;
