export type ManagedSessionInteractionPolicy = {
  question?: 'allow' | 'deny';
  permission?: 'allow' | 'auto-approve' | 'auto-reject';
  terminal?: 'allow' | 'deny';
};

export type ManagedSessionExecutionPolicy = {
  name: string;
  permissionOverrides?: Record<string, unknown>;
  tools?: Record<string, boolean>;
  interaction?: ManagedSessionInteractionPolicy;
  runtime?: {
    nonInteractive?: boolean;
  };
};

export type CloudAgentRuntimeAgent = {
  slug: string;
  name: string;
  config: {
    prompt?: string;
    description?: string;
    mode?: 'subagent' | 'primary' | 'all';
    model?: string | null;
    variant?: string;
    permission?: 'allow' | 'ask' | 'deny' | Record<string, unknown>;
    options?: Record<string, unknown>;
  };
};

export const CODE_REVIEW_RUNTIME_AGENT_SLUG = 'code-review';

const DEFAULT_DENIED_COMMAND_PATTERNS = ['rm -rf', 'sudo rm', 'mkfs', 'dd if='];

// mkdir and touch are intentionally allowed for agent scratch space during analysis.
const CODE_REVIEW_ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'echo',
  'pwd',
  'find',
  'grep',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'jq',
  'git',
  'git fetch',
  'git pull',
  'gh pr diff',
  'gh pr view',
  'gh api repos/*/issues/*/comments --input*',
  'gh api repos/*/issues/comments/* -X PATCH*',
  'gh api repos/*/pulls/*/reviews --input*',
  'glab mr diff',
  'glab mr view',
  'glab api --method POST *merge_requests/*/notes*',
  'glab api --method PUT *merge_requests/*/notes/*',
  'glab api --method POST *merge_requests/*/discussions*',
  'whoami',
  'date',
  'stat',
  'file',
  'head',
  'tail',
  'sed',
  'cd',
  'mkdir',
  'touch',
];

const CODE_REVIEW_DENIED_COMMAND_PATTERNS = [
  'bash',
  'sh',
  'zsh',
  'fish',
  'sed -i',
  'sed -*i',
  'sed --in-place',
  'sed --in-place*',
  'sed * -i',
  'sed * -*i',
  'sed * --in-place',
  'sed * --in-place*',
  'sort -o',
  'sort -o*',
  'sort -*o',
  'sort --output',
  'sort --output*',
  'sort * -o',
  'sort * -o*',
  'sort * -*o',
  'sort * --output',
  'sort * --output*',
  'uniq * *',
  'python',
  'python3',
  'node',
  'irb',
  'php -a',
  'rails console',
  'vi',
  'vim',
  'nvim',
  'nano',
  'emacs',
  'less',
  'more',
  'top',
  'htop',
  'watch',
  'tail -f',
  'ssh',
  'tmux',
  'screen',
  'git add',
  'git branch',
  'git clean',
  'git commit',
  'git config',
  'git mv',
  'git push',
  'git restore',
  'git rm',
  'git merge',
  'git rebase',
  'git cherry-pick',
  'git reset',
  'git checkout',
  'git switch',
  'git stash',
  'git tag',
  'git worktree',
  'git am',
  'git apply',
  'git remote set-url',
  'gh pr merge',
  'gh pr review',
  'gh pr create',
  'gh pr close',
  'gh pr edit',
  'gh pr checkout',
  'gh auth login',
  'gh auth refresh',
  'gh issue',
  'gh repo create',
  'gh repo fork',
  'glab auth',
  'glab mr approve',
  'glab mr close',
  'glab mr create',
  'glab mr delete',
  'glab mr merge',
  'glab mr reopen',
  'glab mr update',
  'glab repo',
  'glab issue',
  'glab pipeline',
  'glab release',
  'glab variable',
  'npm test',
  'pnpm test',
  'bun test',
  'yarn test',
  'pytest',
  'vitest',
];

function buildCommandGuardBashPermissions(params: {
  allowed: readonly string[];
  denied: readonly string[];
}): Record<string, string> {
  const bashPermissions: Record<string, string> = {};
  for (const cmd of params.allowed) {
    bashPermissions[cmd] = 'allow';
    bashPermissions[`${cmd} *`] = 'allow';
  }
  for (const cmd of params.denied) {
    bashPermissions[cmd] = 'deny';
    bashPermissions[`${cmd} *`] = 'deny';
  }
  return bashPermissions;
}

export function buildCodeReviewManagedSessionPolicy(): ManagedSessionExecutionPolicy {
  return {
    name: 'code-review-read-only',
    runtime: { nonInteractive: true },
    interaction: {
      question: 'deny',
      permission: 'auto-reject',
      terminal: 'deny',
    },
    tools: {
      question: false,
      plan_enter: false,
      plan_exit: false,
    },
    permissionOverrides: {
      read: 'allow',
      edit: 'deny',
      bash: buildCommandGuardBashPermissions({
        allowed: CODE_REVIEW_ALLOWED_COMMANDS,
        denied: [...DEFAULT_DENIED_COMMAND_PATTERNS, ...CODE_REVIEW_DENIED_COMMAND_PATTERNS],
      }),
      webfetch: 'deny',
      websearch: 'deny',
      codesearch: 'deny',
      todowrite: 'allow',
      todoread: 'allow',
      question: 'deny',
    },
  };
}

export function buildCodeReviewRuntimeAgent(options: {
  model: string;
  variant?: string;
  permission?: Record<string, unknown>;
}): CloudAgentRuntimeAgent {
  return {
    slug: CODE_REVIEW_RUNTIME_AGENT_SLUG,
    name: 'Code Review',
    config: {
      mode: 'primary',
      model: options.model,
      variant: options.variant,
      description: 'Read-only, non-interactive code review agent.',
      prompt:
        'You are Kilo Code performing a read-only pull request review. Inspect the repository and diff, do not modify files, and follow the user prompt for review output.',
      ...(options.permission ? { permission: options.permission } : {}),
    },
  };
}
