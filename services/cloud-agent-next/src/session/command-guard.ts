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
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'jq',
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
  // A rule is evaluated against the whole command text, and the matcher has no
  // character class, so a rule cannot test one argument token. The entries
  // below therefore refuse the find and sort options that start another program
  // or write a file by name. A command that matches no rule resolves to a
  // prompt, and a code-review session rejects every prompt, so a utility whose
  // only permitted forms cannot be written as a rule keeps no allow rule.
  'find *-exec*',
  'find *-ok*',
  'find *-delete*',
  'find *-fprint*',
  'find *-fls*',
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
  'sort *--compress-program*',
  'sort *--co*',
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

// A permission rule is anchored at both ends of the whole command text, so a
// read rule names the subcommand directly after git. Every other git form keeps
// the git denial, including a read that carries a global option.
const CODE_REVIEW_GIT_READ_SUBCOMMANDS = [
  'diff',
  'fetch',
  'log',
  'pull',
  'rev-parse',
  'show',
  'status',
];

// The review workflow reads with these subcommands and the options named here
// are outside that workflow, so each read rule keeps a matching denial pattern.
// Git accepts any unambiguous prefix of a long option, and the matcher has no
// character class, so a pattern covers the shortest accepted prefix at any
// position, with `=` and with a separating space. `--upload-pack` is the only
// fetch or pull option that starts with `--upl`, so the shorter prefix keeps
// `--unshallow` and the update options available to a shallow review clone. The
// `ext::` remote helper runs the command carried in its URL locally, and that
// URL carries no option, so each read subcommand that takes a remote denies it.
const CODE_REVIEW_GIT_READ_DENIED_OPTION_PATTERNS = [
  'git fetch *--upl*',
  'git pull *--upl*',
  'git fetch *ext::*',
  'git pull *ext::*',
  'git diff *--output*',
  'git log *--output*',
  'git show *--output*',
  'git diff *--ext-diff*',
  'git log *--ext-diff*',
  'git show *--ext-diff*',
  'git diff *--text*',
  'git log *--text*',
  'git show *--text*',
];

// The policy denies the edit tool, so a review session writes no file. An output
// redirect on an allow-listed command is the one write form a pattern can name,
// and it is refused for every command the policy allows. A heredoc payload is
// not part of the classified command text, so the forge publication commands
// keep working; they need no output redirect.
const CODE_REVIEW_WRITE_REDIRECT_DENIED_PATTERNS = [
  ...CODE_REVIEW_ALLOWED_COMMANDS,
  ...CODE_REVIEW_GIT_READ_SUBCOMMANDS.map(subcommand => `git ${subcommand}`),
].map(command => `${command} *>*`);

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
      denied: [...DEFAULT_DENIED_COMMAND_PATTERNS, ...CODE_REVIEW_DENIED_COMMAND_PATTERNS, 'git'],
      // The read set is installed after the git denial, and the last matching
      // rule wins. The denied read options are installed after them.
      allowedAfterDenied: CODE_REVIEW_GIT_READ_SUBCOMMANDS.flatMap(subcommand => [
        `git ${subcommand}`,
        `git ${subcommand} *`,
      ]),
      deniedAfterAllowedOverrides: [
        ...CODE_REVIEW_GIT_READ_DENIED_OPTION_PATTERNS,
        ...CODE_REVIEW_WRITE_REDIRECT_DENIED_PATTERNS,
      ],
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

// The runtime classifies a shell call per parsed command node: the CLI collects
// one pattern for each command in the call and refuses the call when one
// pattern resolves to deny. This resolver classifies the command text of a
// single node with the same pattern rules, so a caller passes one node's text
// and never a joined shell line.
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
