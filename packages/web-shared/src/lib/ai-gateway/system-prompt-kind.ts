/**
 * Guesses which client sent a request from its system prompt. The signals are verbatim phrases
 * from each client's published prompt source, matched case-insensitively after whitespace and
 * apostrophe normalization. Prompts change between releases and users can replace them, so the
 * result is a best guess and null when no client is a clear match.
 *
 * Updating the heuristic (notes for a future agent):
 * - Pick clients by real traffic, not only coding agents. The app leaderboards at
 *   https://openrouter.ai/rankings?view=day#apps and https://vercel.com/ai-gateway/leaderboards/apps
 *   list the most-used apps, including chat apps, personal assistants, roleplay, writing and
 *   agent frameworks. Skip apps that only proxy requests, such as gateways like Portkey, because
 *   they forward their callers' prompts and add none of their own.
 * - Take phrases from the client's actual prompt source, preferably its public repository (pin the
 *   commit in the PR description), then its published package, then collections of captured
 *   prompts. Never guess a phrase. Leave a client out when no reliable source exists.
 * - Prefer an identity sentence that names the product ("You are Kilo,"). Add markers that only
 *   that client sends, such as its docs URL, config directory or tool names. Avoid generic text
 *   shared through forks and conventions, such as `<available_skills>` or Cline-style `TOOL USE`
 *   sections.
 * - Clients rewrite their prompts often, and older versions stay in use, so keep old identity
 *   phrases next to new ones instead of replacing them.
 * - When a client embeds another client's text, such as a fork or a Claude subscription sign-in,
 *   add the relationship to `DOMINATES`.
 * - New kinds are additive: the column and wire field are plain text, so only append to
 *   `SYSTEM_PROMPT_KINDS` and never rename a stored kind. Add a case per prompt variant to
 *   `system-prompt-kind.test.ts`, including a null case for any near miss.
 */
export const SYSTEM_PROMPT_KINDS = [
  'kilo',
  'opencode',
  'cline',
  'claude_code',
  'codex',
  'pi',
  'omp',
  'hermes_agent',
  'openclaw',
  'strix',
  'deepseek_harness',
  'command_code',
] as const;

export type SystemPromptKind = (typeof SYSTEM_PROMPT_KINDS)[number];

type SystemPromptSignals = {
  /** Phrases naming the client itself. One match is enough. */
  identity: readonly string[];
  /** Phrases specific to the client's prompt. Two matches are enough without an identity match. */
  markers: readonly string[];
};

// Lowercase, single-spaced, straight apostrophes: the form `normalize` produces.
const SIGNALS: Record<SystemPromptKind, SystemPromptSignals> = {
  kilo: {
    identity: ['you are kilo,', 'you are kilo code', 'running in kilo, a coding agent harness'],
    markers: [
      'kilo.ai/docs',
      'github.com/kilo-org/kilocode',
      '.kilo/command/',
      '.kilocoderules',
      '.kilocode/rules',
      'kilo_memory_recall',
    ],
  },
  opencode: {
    identity: [
      'you are opencode,',
      'your name is opencode',
      'running in opencode, a coding agent harness',
    ],
    markers: ['opencode.ai/docs', 'github.com/anomalyco/opencode', 'github.com/sst/opencode'],
  },
  cline: {
    identity: ['you are cline,'],
    markers: ['act mode v.s. plan mode', 'plan_mode_respond', 'docs.cline.bot', '.clinerules'],
  },
  claude_code: {
    identity: [
      "claude code, anthropic's official cli for claude",
      "you are a claude agent, built on anthropic's claude agent sdk",
    ],
    markers: [
      'x-anthropic-billing-header: cc_version=',
      '# executing actions with care',
      'measure twice, cut once',
      '<user-prompt-submit-hook>',
    ],
  },
  codex: {
    identity: ['you are codex,', 'running in the codex cli', 'codex cli is an open source project'],
    markers: [
      '# agents.md spec',
      'codex refers to the open-source agentic coding interface',
      'you are clumsy in the git interactive console',
    ],
  },
  pi: {
    identity: ['inside pi, a coding agent harness'],
    markers: [
      'pi documentation (read only when the user asks about',
      'always read pi .md files completely',
      'when reading pi docs or examples',
    ],
  },
  omp: {
    identity: [
      "you are omp's trusted coding assistant",
      'inside oh my pi',
      'in oh my pi coding harness',
    ],
    markers: ['⁂ runtime', '⁂ tool policy', '§ role', 'skill://', 'rfc 2119'],
  },
  hermes_agent: {
    identity: ['you are hermes agent,'],
    markers: [
      'hermes-agent.nousresearch.com',
      '# hermes runtime environment',
      '# tool-use enforcement',
      'skill_view(',
    ],
  },
  openclaw: {
    identity: ['running inside openclaw'],
    markers: [
      '<<<begin_openclaw_internal_context>>>',
      'npm install -g openclaw',
      'openclaw loads below as project context',
    ],
  },
  strix: {
    identity: ['you are strix,', 'you are an advanced ai application security validation agent'],
    markers: [
      'you follow all instructions and rules provided to you exactly as written in the system prompt at all times',
      'you are the root agent. your job is orchestration',
      'docker container with kali linux',
      'refusal avoidance:',
    ],
  },
  deepseek_harness: {
    identity: ['powered by deepseek harness'],
    markers: [
      'check the [exit code: n] marker on every bash result',
      'create_goal may infer goal intent',
      'subagent_fork',
    ],
  },
  command_code: {
    identity: ['you are command code', 'a command code conversation'],
    markers: [
      '.commandcode/',
      'taste system (learned preferences)',
      'always use todo_write (not todowrite)',
      'below are the capabilities, approach, context, and instructions for the coding agent',
      "you're a confident pair programmer, not a formal assistant",
    ],
  },
};

/**
 * A client that embeds another client's identity text. Kilo forked opencode and kept a few
 * opencode-branded prompts, omp forked pi, and clients that sign in with a Claude subscription
 * prepend Claude Code's identity line. The dominating client wins when both match.
 */
const DOMINATES: Partial<Record<SystemPromptKind, readonly SystemPromptKind[]>> = {
  kilo: ['opencode', 'claude_code'],
  opencode: ['claude_code'],
  omp: ['pi', 'claude_code'],
  pi: ['claude_code'],
  cline: ['claude_code'],
  hermes_agent: ['claude_code'],
  openclaw: ['claude_code'],
  command_code: ['claude_code'],
};

const IDENTITY_SCORE = 3;
const MIN_SCORE = 2;
// Bounds the work on the request path; every signal appears well within this.
const MAX_SCANNED_LENGTH = 256 * 1024;

function normalize(text: string): string {
  return text
    .slice(0, MAX_SCANNED_LENGTH)
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, ' ');
}

function score(prompt: string, signals: SystemPromptSignals): number {
  const identity = signals.identity.some(phrase => prompt.includes(phrase)) ? IDENTITY_SCORE : 0;
  return identity + signals.markers.filter(phrase => prompt.includes(phrase)).length;
}

export function classifySystemPrompt(systemPrompt: string): SystemPromptKind | null {
  if (!systemPrompt) return null;
  const prompt = normalize(systemPrompt);

  const scores = new Map<SystemPromptKind, number>();
  for (const kind of SYSTEM_PROMPT_KINDS) {
    const kindScore = score(prompt, SIGNALS[kind]);
    if (kindScore >= MIN_SCORE) scores.set(kind, kindScore);
  }
  for (const kind of [...scores.keys()]) {
    for (const dominated of DOMINATES[kind] ?? []) scores.delete(dominated);
  }

  let best: SystemPromptKind | null = null;
  let bestScore = 0;
  let tied = false;
  for (const [kind, kindScore] of scores) {
    if (kindScore > bestScore) {
      best = kind;
      bestScore = kindScore;
      tied = false;
    } else if (kindScore === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}
