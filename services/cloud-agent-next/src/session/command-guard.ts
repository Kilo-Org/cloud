import { relative } from 'node:path';

import { matchesKiloPermissionPattern } from '../shared/profile-permission-policy.js';

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
  // `sort` writes the file named by its output option, so that option is refused
  // at each position it can take. The option is named with its separator, because
  // a bare `-o` inside a file name is not an option.
  'sort -o *',
  'sort * -o *',
  'sort -o\t*',
  'sort * -o\t*',
  // The option may take its file attached, as `-oconfig` and `-o\tconfig`.
  'sort -o?*',
  'sort * -o?*',
  'sort --output*',
  'sort * --output*',
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

// This policy admits the plain push and requires every other push form to
// resolve to deny. A push rewrites remote history only when it carries an
// option or a `+` refspec, or when git reads a force from its own
// configuration. A rule is anchored at both ends of the whole command text,
// with neither a character class nor a way to see one argument token, so the
// requirement is stated as one rule per position.
//
// A shell hands git the command after its own word splitting, so any run of
// spaces or tabs is one separator. A rule cannot bound a run, so the head takes
// a `*` in place of the separator run; the matcher's `.` matches a tab under its
// single-line flag, so that run may mix spaces and tabs. The same `*` covers a
// global option before the subcommand. It also reads one argument as a
// separator, so a command whose own text names a push option is refused too; the
// reachable push forms are the plain ones below.
//
// A shell expands a `$` or a backtick before git sees the command, and no
// anchored rule can see the split or the substituted text, so the whole policy
// refuses both characters.
//
// A shell also hands git one command for a line continuation. The matcher
// normalizes a backslash to a slash in both the pattern and the command, so a
// continuation reads as a slash before a newline, and the push rule for it
// reaches both a continued line and a literal slash before a newline.
//
// git can take the refspec and the force flag from its own configuration,
// where a rule that reads only the command text cannot see them. A configuration
// write that names a push key, a force key, a mirror key or an alias is
// therefore refused too, whether the write is `git config` or the `-c
// key=value` form on the command line. The forms below also refuse the reads of
// those keys: a rule that admits a read would also admit a write appended to it,
// because a trailing `*` cannot stop before the next argument.
//
// The git configuration files decide what a push does, so a shell write to the
// repository's own file or to the user's own file is refused, by the directory
// spelling, the file-name prefix, the bare target and the spellings of that
// target, and the edit tool refuses the same files through its own map.
//
// The bound: a rule reads the command text, so a write performed inside a
// general-purpose program that this policy admits is outside these rules.
// That program cannot be narrowed by a text rule without refusing the ordinary
// use the fix workflow needs, so the allow list keeps it and this bound stands.
//
// The denies are installed after the `git push` allow, and the last matching
// rule decides. A ref that is deleted by name, with `--delete` or with an empty
// source in the refspec, is not a rewrite; the plain empty-source form carries
// no option, so these rules keep it.
const SECURITY_REMEDIATION_PUSH_HEAD = 'git*push';

// Each form pins the separator directly before the option and the `+`, and lets
// the `*` absorb any run before it, so a run of any length and any mix of
// spaces and tabs is covered.
//
// A shell joins adjacent quoted pieces into one argument, so a quote can split
// one token wherever it sits and no rule can bound the count. The whole policy
// therefore refuses both quote characters, installed last, so the split position
// never has to be named. The cost: a message, a stream edit or a path that
// carries a quote is refused too.
// The matcher rewrites a backslash to a slash, and a shell removes that
// backslash before git runs the command, so a word split by an escape reaches a
// rule as a slash inside the word. The subcommand words that carry a push or a
// configuration write are a fixed list, so every split position of each is named
// here, for every combination of positions a slash can occupy; nothing outside
// that list can split a word into one of them.
// `receive-pack` is left out: the plain push runs it rather than the agent, and
// enumerating every split position of a twelve-letter word costs more rules than
// the map can carry. `git*send-pack*` and every split of `send-pack` remain.
const SECURITY_REMEDIATION_SPLITTABLE_WORDS = ['git', 'push', 'send-pack', 'config'] as const;

// Every split count: the shell removes each escape, and the matcher rewrites the
// backslash that carried it to a slash, so one rule per position of the word is
// not enough. The set enumerates all subsets of the word's positions, so a word
// carries the slash at any combination of its letters.
const SECURITY_REMEDIATION_SPLIT_WORD_DENIED_PATTERNS =
  SECURITY_REMEDIATION_SPLITTABLE_WORDS.flatMap(word => {
    const splits: string[] = [];
    for (let mask = 1; mask < 1 << (word.length - 1); mask += 1) {
      let split = word.slice(0, 1);
      for (let index = 1; index < word.length; index += 1) {
        if ((mask & (1 << (index - 1))) !== 0) split += '/';
        split += word.slice(index, index + 1);
      }
      splits.push(split);
    }
    // A split of the command word itself must stay anchored to the command
    // start, or the rule would refuse any path that happens to contain those
    // characters. A split of a subcommand word sits inside the command, so it
    // takes a wildcard on each side.
    return splits.map(split => (word === 'git' ? `${split} *` : `*${split}*`));
  });

const SECURITY_REMEDIATION_PUSH_DENIED_PATTERNS = [
  `${SECURITY_REMEDIATION_PUSH_HEAD}* -*`,
  `${SECURITY_REMEDIATION_PUSH_HEAD}*\t-*`,
  `${SECURITY_REMEDIATION_PUSH_HEAD}* +*`,
  `${SECURITY_REMEDIATION_PUSH_HEAD}*\t+*`,
  // The matcher normalizes a backslash to a slash in both the pattern and the
  // command, so these rules reach a command that carries a backslash before the
  // option or the `+`. The same normalization makes the last rule reach a line
  // continuation, which a shell hands to git inside one command.
  `${SECURITY_REMEDIATION_PUSH_HEAD}*/-*`,
  `${SECURITY_REMEDIATION_PUSH_HEAD}*/+*`,
  `${SECURITY_REMEDIATION_PUSH_HEAD}*/\n*`,
  // A continuation joins the command for the shell, and after normalization it
  // is a slash before a newline at whatever offset it sits, so one rule covers
  // every split position.
  'git*/\n*',
  // The transport commands carry the same refspec and force options as the push
  // subcommand, and the plain push runs them, so the reachable push forms stay
  // the two plain subcommand forms below.
  'git*send-pack*',
  'git*receive-pack*',
  ...SECURITY_REMEDIATION_SPLIT_WORD_DENIED_PATTERNS,
];

// The repository's own directory name, written once as text and once for each
// glob spelling a shell would resolve to the same directory.
const SECURITY_REMEDIATION_GIT_DIR_SPELLINGS = ['.git', '.g?t', '.g*t'];

// The separator between the directory and its file, written as one path
// component, a run of slashes, and the same with a dot segment. A shell resolves
// each to the directory itself.
const SECURITY_REMEDIATION_GIT_DIR_SEPARATORS = ['/', '//', '///', '/./', '//./', '/.//', '/././'];

// The allowed programs that take the file they write as an argument. `uniq`
// writes its second argument. The general-purpose programs this policy also
// admits are handled separately: the search options that run another program or
// write a named file are refused below, `sort` has its own output option rule,
// and a program run from inside one of them stays outside a text rule.
const SECURITY_REMEDIATION_CONFIG_WRITE_TOOLS = ['cp', 'mv', 'sed', 'uniq'];

// A shell joins adjacent quoted pieces into one argument, so the file name can
// carry a quote at any boundary between its letters and the shell still writes
// the plain name. Every letter boundary is named here for both quote characters,
// once for one quote pair and once for a doubled pair, so a joined segment of
// either kind is covered. A name that carries a quote pair on each of two
// boundaries stays outside these rules.
const SECURITY_REMEDIATION_CONFIG_NAME_QUOTED_PATTERNS = Array.from(
  { length: 'config'.length },
  (_, index) => {
    const prefix = 'config'.slice(0, index + 1);
    const suffix = 'config'.slice(index + 1);
    return ['"', "'"].flatMap(quote => [
      `${prefix}${quote}${suffix}`,
      `${prefix}${quote}${quote}${suffix}`,
    ]);
  }
).flat();

const SECURITY_REMEDIATION_GIT_CONFIG_DENIED_PATTERNS = [
  'git config *push*',
  'git config *force*',
  'git config *alias*',
  'git config *mirror*',
  'git config --add *',
  'git config --replace-all *',
  'git config --unset *',
  'git config -?* *push*',
  'git config -?* *force*',
  'git config -?* alias*',
  'git config -?* *mirror*',
  'git config -?* --add *',
  'git config -?* --replace-all *',
  'git config -?* --unset *',
  // A global option before the subcommand, e.g. `git -C <dir> config …`.
  'git -?* config *push*',
  'git -?* config *force*',
  'git -?* config alias*',
  'git -?* config *mirror*',
  'git -?* config --add *',
  'git -?* config --replace-all *',
  'git -?* config --unset *',
  'git -?* config -?* *push*',
  'git -?* config -?* *force*',
  'git -?* config -?* alias*',
  'git -?* config -?* *mirror*',
  'git -?* config -?* --add *',
  'git -?* config -?* --replace-all *',
  'git -?* config -?* --unset *',
  // An inline setting's argument is a dotted key or carries a `=` value, and its
  // letters are never named, so neither a spelling nor the case of a key can
  // escape. A `?` covers one separator, so a tab or a short run after `-c` is
  // included. The subcommands whose own `-c` takes a branch name are admitted
  // again below: the flag consumes the rest of its argument.
  'git*-c ?*.*',
  'git*-c ?*=*',
  'git*-c*.*=*',
  'git*-c*?=*',
  // The matcher rewrites a backslash to a slash and a shell removes it, so an
  // inline flag written with an escape reaches a rule as a slash before the `c`.
  // The rules above need the contiguous `-c`, so the escaped spelling is named
  // here.
  'git*-/c*.*',
  'git*-/c*?=*',
  'git*-/c*.*=*',
  // git reads the same configuration from the repository's own file, which a
  // shell command can rewrite directly. The CLI evaluates each shell node of a
  // line on its own and never evaluates a `cd` node against this map, so a rule
  // for `cd` would never run. These rules cover the write instead, by the path
  // it names: a path in the repository's own directory is refused by the
  // directory spelling and the file-name prefix, so `config`, `confi?` and
  // `con?ig` are all covered. The user's own configuration file is refused by
  // name. The bound: a write performed by a program this policy does not allow
  // is not covered here, and neither is a path spelled some other way; the edit
  // tool's own map denies the same file.
  // A shell joins adjacent quoted pieces into one argument, so a name can carry
  // a quote at any of its letter boundaries. Each boundary is named, once for
  // each quote character, and the three rules below then cover the same names
  // plus a quote before the name or inside it. A name that carries two quote
  // pairs at once stays outside these rules.
  // A repeated or dot separator reaches the same file, so each spelling is
  // named with a run of slashes and with dot segments between the directory and
  // the file name. The run is enumerated rather than taken as a `*`, because a
  // wildcard there would also reach a file inside a directory whose name merely
  // starts with the same characters.
  ...SECURITY_REMEDIATION_GIT_DIR_SPELLINGS.flatMap(spelling =>
    SECURITY_REMEDIATION_GIT_DIR_SEPARATORS.flatMap(separator => [
      `*${spelling}${separator}c*`,
      `*${spelling}${separator}"c*`,
      `*${spelling}${separator}'c*`,
    ])
  ),
  // A `cd` node is never evaluated, so a write whose target is the bare name
  // cannot be classified by its directory. These rules refuse that target by
  // name, at the cost of refusing a legitimate write to a file or directory
  // named `config`.
  ...SECURITY_REMEDIATION_CONFIG_WRITE_TOOLS.flatMap(tool => [
    `${tool} *config`,
    `${tool} *confi?`,
    // The same target written with a one-character glob or a quoted segment.
    // The separator before it may be a space, a tab or a run, so it takes `*`.
    `${tool} *con?ig`,
    `${tool} *c?nfig`,
    `${tool} *"config"*`,
    `${tool} *'config'*`,
    `${tool} *"confi?"*`,
    `${tool} *'confi?'*`,
    `${tool} *"con?ig"*`,
    `${tool} *"con"*`,
    `${tool} *'con'*`,
    // The same target with a quote joined inside the name at one boundary.
    ...SECURITY_REMEDIATION_CONFIG_NAME_QUOTED_PATTERNS.map(spelling => `${tool} *${spelling}*`),
  ]),
  // The subcommand form compares a key without regard to case, so a rule names
  // the upper-case spelling as well as the lower-case one. The `include` key
  // reads another file as configuration, so a write to it is refused as well.
  ...['PUSH', 'FORCE', 'ALIAS', 'MIRROR', 'INCLUDE'].flatMap(key => [
    `git config *.${key}*`,
    `git -?* config *.${key}*`,
  ]),
  'git config *include*',
  'git -?* config *include*',
  // A configuration read names one key and a write names the key and its value,
  // so the write form is one rule whatever the key is called or however it is
  // cased. The final `?` keeps the rule from ending in ` *`, which the builder
  // would compile as an optional group that also matches the read form.
  'git*config * *?',
  'git*-?* config * *?',
  // The allowed search programs run another program or write a named file
  // through these options, so each is refused, as the review policy already does.
  // `sort` writes the file named by its output option, so that option is refused
  // at each position it can take. The option is named with its separator, because
  // a bare `-o` inside a file name is not an option.
  'sort -o *',
  'sort * -o *',
  'sort -o\t*',
  'sort * -o\t*',
  // The option may take its file attached, as `-oconfig` and `-o\tconfig`.
  'sort -o?*',
  'sort * -o?*',
  'sort --output*',
  'sort * --output*',
  'find *-exec*',
  'find *-execdir*',
  'find *-ok*',
  'find *-delete*',
  'find *-fprint*',
  'find *-fls*',
  // A tab is one separator, so the inline-setting rules name it as the space
  // rules do.
  'git*-c\t?*.*',
  'git*-c\t?*=*',
  // One rule per operator absorbs the whole run before the target, so any
  // spacing or tab is covered. A rule reads the command text the runtime
  // classifies, which for a compound line is one node at a time and not the
  // redirection that node carries, so that redirection stays outside these
  // rules; a write whose target is an argument, such as a copy or a move, keeps
  // its target in that text and stays covered.
  //
  // The shell strips the quote before the write, so the target is matched with a
  // quote at each letter boundary as well as at its start.
  '*>*config',
  '*>*confi?',
  ...['"', "'"].map(quote => `*>*${quote}config*`),
  ...SECURITY_REMEDIATION_CONFIG_NAME_QUOTED_PATTERNS.map(spelling => `*>*${spelling}*`),
  '*gitconfig*',
  '*>*gitcon*',
];

// Installed after the denies, and only for the branch-creation form, whose `-c`
// copies a branch and consumes its arguments.
const SECURITY_REMEDIATION_GIT_INLINE_ALLOWED_AFTER_DENIED = [
  'git switch -c *',
  'git branch -c *',
  'git -?* switch -c *',
  'git -?* branch -c *',
];

// The branch-creation rules above take a `*` before the subcommand, so that `*`
// can absorb a global option and the inline setting it carries. These rules are
// installed after those allows, so a command that carries an inline setting and
// then a branch-creation form takes the setting's decision again. Each rule takes
// a `*` wherever a separator run can sit, so a setting written with a tab or a
// mixed run is included. Each rule also names the setting's own argument, a key
// with a dot or a key with a value, so a branch name that merely carries a
// subcommand word keeps the allow above.
const SECURITY_REMEDIATION_GIT_INLINE_DENIED_AFTER_ALLOWED = [
  'git*-c*.*switch*',
  'git*-c*=*switch*',
  'git*-c*.*branch*',
  'git*-c*=*branch*',
  // The matcher rewrites a backslash to a slash and a shell removes it, so an
  // inline flag written with an escape reaches a rule as a slash before the `c`.
  // The rules above need the contiguous `-c`, so the escaped spelling is named
  // here as well as in the deny set.
  'git*-/c*',
];

const SECURITY_REMEDIATION_DENIED_COMMAND_PATTERNS = [
  'git reset --hard',
  'git clean',
  ...SECURITY_REMEDIATION_PUSH_DENIED_PATTERNS,
  ...SECURITY_REMEDIATION_GIT_CONFIG_DENIED_PATTERNS,
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
      allowedAfterDenied: SECURITY_REMEDIATION_GIT_INLINE_ALLOWED_AFTER_DENIED,
      deniedAfterAllowedOverrides: SECURITY_REMEDIATION_GIT_INLINE_DENIED_AFTER_ALLOWED,
      // A shell expands a `$` or a backtick before git sees the command, so the
      // text a rule reads is not the text git runs, and it joins quoted pieces
      // before the command runs. Installed last, so these rules decide every
      // command that carries one of these characters.
      terminalDenied: ['*$*', '*`*', "*'*", '*"*'],
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
): Record<string, 'allow' | 'deny'> {
  // Denies are inserted after allows so exact duplicates still fail closed;
  // more-specific denied sub-commands also override broader allowed commands in the CLI matcher.
  const bashPermissions: Record<string, 'allow' | 'deny'> = {};
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

export type CommandGuardPermission = 'allow' | 'deny' | Record<string, 'allow' | 'deny'>;

export function getCommandGuardPermissions(
  policy: CommandGuardPolicy,
  workspacePath: string,
  bitbucketReviewId?: string
): Record<string, CommandGuardPermission> {
  const bitbucketReviewPolicy = policy.policyName === 'bitbucket-code-review-read-only';
  const securityRemediationPolicy = policy.policyName === 'security-remediation-pr';
  return {
    edit: securityRemediationPolicy
      ? // The edit tool writes any path without a shell command, and git reads
        // its configuration from both the repository's own file and the user's
        // file, so both stay out of reach while every other path stays writable.
        {
          '*': 'allow',
          '.git': 'deny',
          '.git/*': 'deny',
          '*.git': 'deny',
          '*.git/*': 'deny',
          '.g?t': 'deny',
          '.g?t/*': 'deny',
          '.g*t': 'deny',
          '.g*t/*': 'deny',
          '*gitconfig*': 'deny',
          '*/.git/config*': 'deny',
          // The user-level file is refused by its own name, so the repository
          // directory stays the only `.git` path this map singles out.
          '*gitconfig*': 'deny',
          // The user-level file also lives under the XDG config directory, which
          // is named with its dot so an ordinary `git/` source directory stays
          // editable.
          '*/.config/git/config*': 'deny',
        }
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

export { matchesKiloPermissionPattern };

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
