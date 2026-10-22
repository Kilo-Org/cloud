import { relative } from 'node:path';

const DEFAULT_DENIED_COMMAND_PATTERNS = ['rm -rf', 'sudo rm', 'mkfs', 'dd if='];

export function bitbucketReviewInputPath(reviewId: string): string {
  return `/tmp/bb-${reviewId}/input.json`;
}

// Keep in sync with: cloudflare-code-review-infra/src/code-review-orchestrator.ts
// mkdir and touch are intentionally allowed for agent scratch space during analysis
const CODE_REVIEW_ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'echo',
  'pwd',
  'find',
  'grep',
  'rg',
  'awk',
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
  'gh api repos/*/pulls/*/reviews',
  'gh api repos/*/pulls/*/comments',
  'gh api repos/*/issues/*/comments',
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

const BITBUCKET_CODE_REVIEW_SHELL_SYNTAX_DENIES = [
  '*$*',
  '*`*',
  '*;*',
  '*|*',
  '*&&*',
  '*||*',
  '*>*',
  '*\n*',
];

function bitbucketCodeReviewAllowedCommands(reviewId: string): string[] {
  const inputPath = bitbucketReviewInputPath(reviewId);
  return [
    'bb',
    'bb help',
    'bb --help',
    'bb -h',
    'bb pr current',
    'bb pr create --title *',
    'bb pr view *',
    'bb pr diff *',
    'bb comments list *',
    'bb comments create * --input -',
    'bb comments create-batch * --input -',
    'bb comments update * * --input -',
    `bb comments create * --input - < ${inputPath}`,
    `bb comments create-batch * --input - < ${inputPath}`,
    `bb comments update * * --input - < ${inputPath}`,
  ];
}

function bitbucketCodeReviewDeniedCommands(reviewId: string): string[] {
  const inputPath = bitbucketReviewInputPath(reviewId);
  return [
    'bb pr create --title * < *',
    'bb pr view * ?*',
    'bb pr diff * ?*',
    'bb comments list * ?*',
    'bb comments create * * --input -',
    'bb comments create-batch * * --input -',
    'bb comments update * * * --input -',
    `bb comments create * * --input - < ${inputPath}`,
    `bb comments create-batch * * --input - < ${inputPath}`,
    `bb comments update * * * --input - < ${inputPath}`,
  ];
}

const BITBUCKET_CODE_REVIEW_DIFF_NAME_ONLY_ALLOWED_COMMANDS = ['bb pr diff * --name-only'];

const BITBUCKET_CODE_REVIEW_DIFF_NAME_ONLY_DENIED_COMMANDS = [
  'bb pr diff * ?* --name-only',
  'bb pr diff * --name-only ?*',
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
  'awk * -i*',
  'awk * --in-place*',
  'awk *system(*',
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
  'gh api repos/*/pulls/*/reviews --method*',
  'gh api repos/*/pulls/*/reviews -X*',
  'gh api repos/*/pulls/*/reviews -f*',
  'gh api repos/*/pulls/*/reviews -F*',
  'gh api repos/*/pulls/*/reviews --field*',
  'gh api repos/*/pulls/*/reviews --raw-field*',
  'gh api repos/*/pulls/*/comments --method*',
  'gh api repos/*/pulls/*/comments -X*',
  'gh api repos/*/pulls/*/comments -f*',
  'gh api repos/*/pulls/*/comments -F*',
  'gh api repos/*/pulls/*/comments --field*',
  'gh api repos/*/pulls/*/comments --raw-field*',
  'gh api repos/*/pulls/*/comments --input*',
  'gh api repos/*/issues/*/comments --method*',
  'gh api repos/*/issues/*/comments -X*',
  'gh api repos/*/issues/*/comments -f*',
  'gh api repos/*/issues/*/comments -F*',
  'gh api repos/*/issues/*/comments --field*',
  'gh api repos/*/issues/*/comments --raw-field*',
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

const SECURITY_REMEDIATION_ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'echo',
  'pwd',
  'find',
  'grep',
  'rg',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'jq',
  'git',
  'git status',
  'git diff',
  'git branch',
  'git checkout',
  'git switch',
  'git add',
  'git commit',
  'git push',
  'gh pr create',
  'gh pr view',
  'gh pr diff',
  'npm',
  'npm install',
  'npm run',
  'npm test',
  'pnpm',
  'pnpm install',
  'pnpm run',
  'pnpm test',
  'bun',
  'bun install',
  'bun run',
  'bun test',
  'yarn',
  'yarn install',
  'yarn run',
  'yarn test',
  'python',
  'python3',
  'python -m',
  'python3 -m',
  'pip',
  'pip3',
  'pytest',
  'go',
  'go test',
  'mvn',
  'gradle',
  'bundle',
  'vitest',
  'sed',
  'cd',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'rm',
];

const SECURITY_REMEDIATION_DENIED_COMMAND_PATTERNS = [
  'git reset --hard',
  'git clean',
  'git push --force',
  'git push -f',
  'git push * --force',
  'git push * -f',
  'git push --mirror',
  'git remote set-url',
  'git tag',
  'git worktree',
  'git stash',
  'gh pr merge',
  'gh pr close',
  'gh pr edit',
  'gh pr checkout',
  'gh auth',
  'gh repo',
  'gh secret',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'docker',
  'kubectl',
  'wrangler',
  'vercel',
];

export type CommandGuardPolicy = {
  policyName: string;
  allowed: string[];
  exactAllowed?: string[];
  denied: string[];
  allowedAfterDenied?: string[];
  deniedAfterAllowedOverrides?: string[];
  terminalDenied?: string[];
  defaultDeny?: boolean;
};

export function getCommandGuardPolicy(
  createdOnPlatform?: string,
  platform?: 'github' | 'gitlab' | 'bitbucket',
  bitbucketReviewId?: string
): CommandGuardPolicy | null {
  if (createdOnPlatform === 'security-remediation') {
    return {
      policyName: 'security-remediation-pr',
      allowed: SECURITY_REMEDIATION_ALLOWED_COMMANDS,
      denied: [...DEFAULT_DENIED_COMMAND_PATTERNS, ...SECURITY_REMEDIATION_DENIED_COMMAND_PATTERNS],
    };
  }

  if (createdOnPlatform === 'code-review') {
    if (platform === 'bitbucket') {
      const exactAllowed = bitbucketReviewId
        ? bitbucketCodeReviewAllowedCommands(bitbucketReviewId)
        : [];
      return {
        policyName: 'bitbucket-code-review-read-only',
        allowed: [],
        exactAllowed,
        denied: bitbucketReviewId ? bitbucketCodeReviewDeniedCommands(bitbucketReviewId) : [],
        allowedAfterDenied: bitbucketReviewId
          ? BITBUCKET_CODE_REVIEW_DIFF_NAME_ONLY_ALLOWED_COMMANDS
          : [],
        deniedAfterAllowedOverrides: bitbucketReviewId
          ? BITBUCKET_CODE_REVIEW_DIFF_NAME_ONLY_DENIED_COMMANDS
          : [],
        terminalDenied: BITBUCKET_CODE_REVIEW_SHELL_SYNTAX_DENIES,
        defaultDeny: true,
      };
    }
    return {
      policyName: 'code-review-read-only',
      allowed: CODE_REVIEW_ALLOWED_COMMANDS,
      denied: [...DEFAULT_DENIED_COMMAND_PATTERNS, ...CODE_REVIEW_DENIED_COMMAND_PATTERNS],
    };
  }

  return null;
}

export function buildCommandGuardBashPermissions(
  commandGuardPolicy: CommandGuardPolicy
): Record<string, string> {
  // Denies are inserted after allows so exact duplicates still fail closed;
  // more-specific denied sub-commands also override broader allowed commands in the CLI matcher.
  const bashPermissions: Record<string, string> = {};
  if (commandGuardPolicy.defaultDeny) {
    bashPermissions['*'] = 'deny';
  }
  for (const cmd of commandGuardPolicy.allowed) {
    bashPermissions[cmd] = 'allow';
    bashPermissions[`${cmd} *`] = 'allow';
  }
  for (const cmd of commandGuardPolicy.exactAllowed ?? []) {
    bashPermissions[cmd] = 'allow';
  }
  for (const cmd of commandGuardPolicy.denied) {
    bashPermissions[cmd] = 'deny';
    bashPermissions[`${cmd} *`] = 'deny';
  }
  for (const cmd of commandGuardPolicy.allowedAfterDenied ?? []) {
    bashPermissions[cmd] = 'allow';
  }
  for (const cmd of commandGuardPolicy.deniedAfterAllowedOverrides ?? []) {
    bashPermissions[cmd] = 'deny';
    bashPermissions[`${cmd} *`] = 'deny';
  }
  for (const cmd of commandGuardPolicy.terminalDenied ?? []) {
    bashPermissions[cmd] = 'deny';
    bashPermissions[`${cmd} *`] = 'deny';
  }
  return bashPermissions;
}

export function getCommandGuardPermissions(
  policy: CommandGuardPolicy,
  workspacePath: string,
  bitbucketReviewId?: string
): Record<string, string | Record<string, string>> {
  const bitbucketReviewPolicy = policy.policyName === 'bitbucket-code-review-read-only';
  return {
    edit:
      policy.policyName === 'security-remediation-pr'
        ? 'allow'
        : bitbucketReviewPolicy && bitbucketReviewId
          ? {
              '*': 'deny',
              [relative(workspacePath, bitbucketReviewInputPath(bitbucketReviewId))]: 'allow',
            }
          : 'deny',
    bash: buildCommandGuardBashPermissions(policy),
    ...(bitbucketReviewPolicy ? { task: 'deny', lsp: 'deny' } : {}),
    webfetch: 'deny',
    websearch: 'deny',
    codesearch: 'deny',
    todowrite: 'allow',
    todoread: 'allow',
  };
}

function matchesKiloPermissionPattern(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
}

export function resolveCommandGuardBashPermission(
  permissions: Record<string, string>,
  command: string
): string | undefined {
  let result: string | undefined;
  for (const [pattern, action] of Object.entries(permissions)) {
    if (matchesKiloPermissionPattern(command, pattern)) result = action;
  }
  return result;
}
