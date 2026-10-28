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

const hookEvents = {
  PreToolUse:
    'Before a tool call. Exit 2 or a JSON deny blocks the call; ask forces a confirmation prompt.',
  PostToolUse:
    'After a tool call succeeds. Exit 2 stderr, a block reason or additionalContext is shown to the model; updatedToolOutput replaces the output.',
  PostToolUseFailure:
    'After a tool call fails (including a shell command that exits non-zero). additionalContext is shown to the model.',
  PostToolBatch:
    'After a model step that ran tools, before the next model call. A block stops the turn.',
  PermissionRequest:
    'When Kilo shows a permission prompt for a tool call. A JSON deny denies the call; hooks cannot approve.',
  TaskCreated: 'When a todo is added. A block rolls back that todo.',
  TaskCompleted: 'When a todo is marked completed. A block keeps that todo open.',
  UserPromptSubmit:
    'When a prompt or command is submitted. A block rejects it; stdout or additionalContext is added to the prompt.',
  UserPromptExpansion: 'When a custom command, skill or MCP prompt expands. Matcher: command name.',
  PreModelSwitch:
    'Before a prompt switches the session to another model. A block, ask or timeout rejects the prompt. Matcher: model name.',
  PostModelSwitch:
    'After the session model changed. stdout or additionalContext is added to the next request.',
  SessionStart:
    'When a session starts, resumes, forks or is compacted. Matcher: startup, resume, fork, compact. stdout or additionalContext is added to the conversation.',
  SessionEnd: 'When a session is deleted or Kilo exits. Matcher: other, prompt_input_exit.',
  InstructionsLoaded:
    'When an instruction file (AGENTS.md, CLAUDE.md) is loaded. Matcher: session_start, nested_traversal, compact.',
  Stop: 'When the agent finishes responding. A block makes it continue (at most 8 times in a row).',
  SubagentStop: 'When a subagent finishes. A block makes it continue. Matcher: agent type.',
  SubagentStart:
    'When a subagent starts. additionalContext is added to its first prompt. Matcher: agent type.',
  StopFailure: 'When a turn ends with an API error. Matcher: error type.',
  PreCompact: 'Before compaction. A block skips it. Matcher: manual, auto.',
  PostCompact: 'After compaction. Matcher: manual, auto.',
  Notification:
    'When Kilo is waiting for you. Matcher: permission_prompt, agent_needs_input, idle_prompt.',
  ConfigChange:
    'After Kilo changes its config. Matcher: user_settings, project_settings. Cannot block; not read from Claude Code settings.',
  FileChanged: 'When a watched file changes. Matcher: file names to watch, separated by |.',
  CwdChanged: 'When a shell command runs in a different directory than the previous one.',
  GoalReport:
    'Kilo only. Before a /goal is marked complete or blocked. A block keeps the goal running. Matcher: complete, blocked.',
  WakeupFire:
    'Kilo only. Before a scheduled wakeup or cron task runs. A block skips it. Matcher: once, cron.',
  WorktreeSetup:
    'Kilo only. After a managed worktree is created and its setup script ran. A block marks setup as failed.',
  WorktreeTeardown: 'Kilo only. Before a managed worktree is removed.',
  CommitMessage:
    'Kilo only. After a commit message is generated. hookSpecificOutput.commitMessage replaces it; a block rejects it.',
  BranchName:
    'Kilo only. After a worktree branch name is generated. hookSpecificOutput.branchName replaces it; a block keeps the current name.',
} as const;

const hookGroups = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      matcher: {
        description:
          'What it matches depends on the event (tool name, source, trigger, ...): "*" or omitted matches everything, "a|b" matches exact names, anything else is a regular expression. Ignored on events without a matcher.',
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
                'Command to run. Without args it runs in bash (Git Bash on Windows) or the platform shell; with args it is the program to spawn directly. It receives the hook input as JSON on stdin.',
              type: 'string',
            },
            args: {
              description:
                'Arguments for exec form: the command is spawned directly, without a shell.',
              type: 'array',
              items: { type: 'string' },
            },
            shell: {
              description: 'Shell for the command when args is not set. Default: bash.',
              type: 'string',
              enum: ['bash', 'powershell'],
            },
            if: {
              description:
                'Tool events only: a permission-rule condition such as "Bash(rm *)" or "Edit(*.env)". The hook runs only when the call matches, or when Kilo cannot tell.',
              type: 'string',
            },
            timeout: {
              description:
                'Timeout in seconds. Default: 600; 30 for UserPromptSubmit and the model-switch events; 10 for BranchName; see the docs for the rest. A hook that times out does not block unless onFailure is "block"; on PreModelSwitch a timeout always blocks.',
              type: 'integer',
              exclusiveMinimum: 0,
            },
            onFailure: {
              description:
                'What happens when the hook fails (cannot start, times out, exits with a code other than 0 or 2, prints invalid JSON): "continue" (default) lets the action proceed, "block" blocks it (on PermissionRequest: denies). Honored only on PreToolUse, PostToolBatch, PermissionRequest, TaskCreated, UserPromptSubmit, UserPromptExpansion, PreModelSwitch, PreCompact, WakeupFire, WorktreeSetup, CommitMessage and BranchName.',
              type: 'string',
              enum: ['continue', 'block'],
            },
            async: {
              description:
                'Run in the background without waiting. Output, exit code and onFailure are ignored.',
              type: 'boolean',
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
        'Shell command hooks run on agent events. Uses the Claude Code hooks format; behavior matches Claude Code 2.1.301 except where the docs list a difference. Only read from global, managed, or organization config; project config hooks are ignored.',
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(hookEvents).map(([name, description]) => [
          name,
          { description, ...hookGroups },
        ])
      ),
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
