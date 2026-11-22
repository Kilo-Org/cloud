import { describe, expect, it } from 'vitest';
import {
  bitbucketReviewInputPath,
  buildCommandGuardBashPermissions,
  getCommandGuardPolicy,
  resolveCommandGuardBashPermission,
} from './command-guard.js';

describe('code-review command guard policy', () => {
  it('allows required review publication and remote refresh commands while denying repository mutation', () => {
    const policy = getCommandGuardPolicy('code-review');
    if (!policy) throw new Error('Expected code-review command guard policy');

    const bashPermissions = buildCommandGuardBashPermissions(policy);

    expect(bashPermissions['glab']).toBeUndefined();
    expect(bashPermissions['glab *']).toBeUndefined();
    expect(bashPermissions['gh']).toBeUndefined();
    expect(bashPermissions['gh *']).toBeUndefined();
    expect(bashPermissions['gh api']).toBeUndefined();
    expect(bashPermissions['gh api *']).toBeUndefined();

    expect(bashPermissions['rg']).toBe('allow');
    expect(bashPermissions['rg *']).toBe('allow');

    // The matcher cannot test one argument token, so these two utilities carry
    // no allow rule. A command that matches no rule resolves to a prompt, and a
    // code-review session rejects every prompt.
    for (const removedUtility of ['sed', 'awk']) {
      expect(bashPermissions[removedUtility]).toBeUndefined();
      expect(bashPermissions[`${removedUtility} *`]).toBeUndefined();
    }

    expect(bashPermissions['glab mr diff']).toBe('allow');
    expect(bashPermissions['glab mr diff *']).toBe('allow');
    expect(bashPermissions['glab api --method POST *merge_requests/*/notes*']).toBe('allow');
    expect(bashPermissions['glab api --method PUT *merge_requests/*/notes/*']).toBe('allow');
    expect(bashPermissions['glab api --method POST *merge_requests/*/discussions*']).toBe('allow');

    expect(bashPermissions['gh pr diff']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/reviews']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/reviews *']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/comments']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/comments *']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/*/comments']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/*/comments *']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/*/comments --input*']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/comments/* -X PATCH*']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/reviews --input*']).toBe('allow');

    for (const readOnlyGhApiCommand of [
      'gh api repos/*/pulls/*/reviews',
      'gh api repos/*/pulls/*/comments',
      'gh api repos/*/issues/*/comments',
    ]) {
      for (const mutationFlag of ['--method*', '-X*', '-f*', '-F*', '--field*', '--raw-field*']) {
        const deniedCommand = `${readOnlyGhApiCommand} ${mutationFlag}`;
        expect(bashPermissions[deniedCommand]).toBe('deny');
        expect(bashPermissions[`${deniedCommand} *`]).toBe('deny');
      }
    }
    expect(bashPermissions['gh api repos/*/pulls/*/comments --input*']).toBe('deny');
    expect(bashPermissions['gh api repos/*/pulls/*/comments --input* *']).toBe('deny');

    for (const deniedFindOption of [
      'find *-exec*',
      'find *-ok*',
      'find *-delete*',
      'find *-fprint*',
      'find *-fls*',
    ]) {
      expect(bashPermissions[deniedFindOption]).toBe('deny');
      expect(bashPermissions[`${deniedFindOption} *`]).toBe('deny');
    }

    for (const deniedSortOption of ['sort *--compress-program*', 'sort *--co*']) {
      expect(bashPermissions[deniedSortOption]).toBe('deny');
      expect(bashPermissions[`${deniedSortOption} *`]).toBe('deny');
    }

    expect(bashPermissions['git']).toBe('deny');
    expect(bashPermissions['git *']).toBe('deny');
    expect(bashPermissions['git fetch']).toBe('allow');
    expect(bashPermissions['git fetch *']).toBe('allow');
    expect(bashPermissions['git pull']).toBe('allow');
    expect(bashPermissions['git pull *']).toBe('allow');
    // A write subcommand carries no rule of its own; the git denial classifies it.
    expect(bashPermissions['git push']).toBeUndefined();
    expect(bashPermissions['git commit']).toBeUndefined();
    expect(bashPermissions['glab mr merge']).toBe('deny');
    expect(bashPermissions['glab mr merge *']).toBe('deny');
    expect(bashPermissions['glab auth']).toBe('deny');
    expect(bashPermissions['glab auth *']).toBe('deny');
  });

  it('resolves permitted and refused commands in the read-only review policy', () => {
    const policy = getCommandGuardPolicy('code-review');
    if (!policy) throw new Error('Expected code-review command guard policy');
    const permissions = buildCommandGuardBashPermissions(policy);

    // A command with no matching rule resolves to undefined, which the runtime
    // turns into a prompt that a code-review session rejects.
    for (const command of [
      "sed -i 's/a/b/' src/app.ts",
      "sed -i.bak 's/a/b/' src/app.ts",
      "sed -iE 's/a/b/' src/app.ts",
      "sed -ni '1,5p' src/app.ts",
      "sed -Ei 's/a/b/' src/app.ts",
      "sed -nri 's/a/b/' src/app.ts",
      "sed --in-place 's/a/b/' src/app.ts",
      "sed --in-place=.bak 's/a/b/' src/app.ts",
      "sed 's/a/b/' -i src/app.ts",
      "sed -n '1,20p' src/app.ts",
      'awk \'BEGIN { print "x" | "sh" }\'',
      'awk -f /tmp/program.awk src/app.ts',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBeUndefined();
    }

    for (const command of [
      "find . -exec sh -c 'id' +",
      'find . -execdir rm {} +',
      'find . -ok rm {} +',
      'find . -okdir rm {} +',
      "find . -name '*.tmp' -delete",
      'find . -fprint out.txt',
      "find . -fprintf out.txt '%p'",
      'find . -fls out.txt',
      'sort --compress-program=/bin/sh src/app.ts',
      'sort -k1 --compress-program=/bin/sh src/app.ts',
      'sort --co=/bin/sh src/app.ts',
      'sort -o out.txt src/app.ts',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }

    for (const command of [
      'rg -n "createSession" src',
      'grep -rn "createSession" src',
      "find . -name '*.ts' -type f",
      'find src -maxdepth 2 -type d',
      'sort -u src/app.ts',
      'sort -k2 -n src/app.ts',
      'head -20 src/app.ts',
      'tail -n 40 src/app.ts',
      'wc -l src/app.ts',
      'cut -d, -f1 data.csv',
      'jq . package.json',
      'git diff',
      'git show HEAD',
      'gh pr diff 42 --patch --color never',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('allow');
    }
  });

  it('resolves git by name only when the subcommand directly follows git', () => {
    const policy = getCommandGuardPolicy('code-review');
    if (!policy) throw new Error('Expected code-review command guard policy');
    const permissions = buildCommandGuardBashPermissions(policy);

    // A global option before the subcommand keeps the git denial, whichever
    // subcommand follows.
    for (const command of [
      'git -C /tmp/review push',
      'git -C /tmp/review push origin main',
      'git -c user.name=review commit -m note',
      'git --git-dir=/tmp/review/.git reset --hard HEAD~1',
      'git --work-tree=/tmp/review config user.email review@example.com',
      'git --no-pager push',
      'git -C /tmp/review remote set-url origin https://example.com/repo.git',
      'git -C /tmp/review branch -D main',
      'git --no-pager update-ref -m log refs/heads/main HEAD',
      'git -C /tmp/review update-ref -m log refs/heads/main HEAD',
      'git -C /tmp/review log --oneline -1',
      'git --no-pager diff --stat',
      'git push',
      'git commit -m note',
      'git reset --hard HEAD~1',
      'git config user.email review@example.com',
      // Git accepts an unambiguous prefix of a subcommand, and a git form the
      // policy does not name keeps the git denial.
      'git pus origin main',
      'git update-ref refs/heads/main HEAD',
      'git --version',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }

    for (const command of [
      'git diff',
      'git diff HEAD~1..HEAD',
      'git log --oneline -5',
      'git show HEAD:src/app.ts',
      'git status --porcelain',
      'git rev-parse HEAD',
      'git fetch origin',
      'git fetch --prune origin',
      'git pull',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('allow');
    }
  });

  it('keeps the fetch and pull read rules inside the review workflow', () => {
    const policy = getCommandGuardPolicy('code-review');
    if (!policy) throw new Error('Expected code-review command guard policy');
    const permissions = buildCommandGuardBashPermissions(policy);

    expect(permissions['git fetch *--upl*']).toBe('deny');
    expect(permissions['git pull *--upl*']).toBe('deny');
    expect(permissions['git fetch *ext::*']).toBe('deny');
    expect(permissions['git pull *ext::*']).toBe('deny');

    // The option is matched at any position, with `=` or a separating space, and
    // through any accepted prefix.
    for (const command of [
      'git fetch --upload-pack=./fetch-helper .',
      'git fetch --upload-pack ./fetch-helper .',
      'git fetch --upload-pack=./fetch-helper file:///tmp/repo',
      'git fetch origin --upload-pack=./fetch-helper',
      'git fetch --upl=./fetch-helper /tmp/repo',
      'git fetch --upload-p=./fetch-helper /tmp/repo',
      'git pull --upload-pack=./fetch-helper file:///tmp/repo',
      'git pull --upload-pack ./fetch-helper',
      'git pull origin --upl=./fetch-helper',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }

    // The `ext::` remote helper runs the command carried in its URL locally.
    for (const command of [
      "git fetch ext::sh -c 'id > /tmp/pwned'",
      'git fetch origin ext::sh -c id',
      "git pull 'ext::sh -c id'",
      'git pull origin ext::./helper',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }

    // The read forms of the review workflow resolve to allow.
    for (const command of [
      'git fetch origin',
      'git fetch --prune origin',
      'git fetch origin main',
      'git fetch --unshallow origin',
      'git fetch --update-head-ok origin',
      'git fetch --update-shallow origin',
      'git pull',
      'git pull origin main',
      'git pull --ff-only',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('allow');
    }
  });

  it('keeps the diff, log and show read rules inside the review workflow', () => {
    const policy = getCommandGuardPolicy('code-review');
    if (!policy) throw new Error('Expected code-review command guard policy');
    const permissions = buildCommandGuardBashPermissions(policy);

    for (const command of [
      'git diff --output=.git/hooks/pre-merge-commit HEAD',
      'git diff HEAD --output=notes.txt',
      'git log --output=notes.txt -5',
      'git show --output=notes.txt HEAD',
      'git diff --ext-diff HEAD',
      'git log --ext-diff -1',
      'git show --ext-diff HEAD',
      'git diff --textconv HEAD',
      'git log --text -1',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }

    for (const command of [
      'git diff',
      'git diff HEAD~1..HEAD',
      'git diff --no-ext-diff --no-textconv HEAD',
      'git log --oneline -5',
      'git show HEAD:src/app.ts',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('allow');
    }
  });

  it('keeps a review session from writing a file with an output redirect', () => {
    const policy = getCommandGuardPolicy('code-review');
    if (!policy) throw new Error('Expected code-review command guard policy');
    const permissions = buildCommandGuardBashPermissions(policy);

    for (const command of [
      'echo "[diff]" >> .git/config',
      'echo "	external = ./helper" >> .git/config',
      'cat > .git/config',
      'cat > .git/hooks/pre-merge-commit',
      'head -20 src/app.ts > notes.txt',
      'tail -n 40 src/app.ts >> notes.txt',
      'grep -rn "createSession" src > matches.txt',
      'jq . package.json > copy.json',
      'find src -name "*.ts" > files.txt',
      'gh pr view 1 --jq \'"[diff]"\' > .git/config',
      'glab mr view 1 > .git/config',
      'gh api repos/o/r/pulls/7/comments > notes.json',
      'git diff HEAD > .git/config',
      'git log --oneline -5 > history.txt',
      'git show HEAD:src/app.ts > copy.ts',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }

    for (const command of [
      'echo hi',
      'cat src/app.ts',
      'head -20 src/app.ts',
      'jq . package.json',
      'git diff HEAD',
      'git log --oneline -5',
      // Review publication keeps working. The classified text of a call is one
      // parsed command node, so a heredoc payload is not part of it; the CLI
      // run in the pull request covers that path.
      'gh api repos/o/r/pulls/7/reviews --input -',
      'gh pr view 7 --json headRefOid',
      'glab mr diff 7',
      'glab api --method POST projects/o%2Fr/merge_requests/7/notes',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('allow');
    }
  });

  it('matches only purpose-built Bitbucket review commands and exact scratch redirection', () => {
    const reviewId = '123e4567-e89b-12d3-a456-426614174023';
    const inputPath = bitbucketReviewInputPath(reviewId);
    const policy = getCommandGuardPolicy('code-review', 'bitbucket', reviewId);
    if (!policy) throw new Error('Expected Bitbucket code-review command guard policy');

    const permissions = buildCommandGuardBashPermissions(policy);
    for (const command of [
      'bb',
      'bb help',
      'bb --help',
      'bb -h',
      'bb pr current',
      'bb pr create --title "Add safer widgets"',
      'bb pr create --title "Add safer widgets" --description "Ready for review"',
      'bb pr create --title "Add safer widgets" --destination main',
      'bb pr view 42',
      'bb pr diff 42',
      'bb pr diff 42 --name-only',
      'bb comments list 42',
      'bb comments create 42 --input -',
      'bb comments create-batch 42 --input -',
      'bb comments update 42 31 --input -',
      `bb comments create 42 --input - < ${inputPath}`,
      `bb comments create-batch 42 --input - < ${inputPath}`,
      `bb comments update 42 31 --input - < ${inputPath}`,
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('allow');
    }

    for (const command of [
      'env',
      'printenv BITBUCKET_TOKEN',
      'echo $BITBUCKET_TOKEN',
      'cat /proc/self/environ',
      'python -c "print(1)"',
      'node -e "console.log(1)"',
      'pnpm exec tsx script.ts',
      'curl https://api.bitbucket.org/2.0/user',
      './repository-script',
      'git status --short',
      'git rev-parse HEAD',
      'git diff --no-ext-diff --no-textconv',
      'git show --no-ext-diff --no-textconv --format=fuller --stat HEAD',
      'git config --get-regexp alias',
      'git fetch origin',
      'git diff',
      'bb help extra',
      'bb --debug pr view 42',
      'bb pr current extra',
      'bb pr create',
      'bb pr create --description "Ready for review"',
      'bb pr create --title "Add safer widgets" < /tmp/other.json',
      'bb comments create 42 --input - --workspace other',
      'bb comments create-batch 42 --input - --workspace other',
      'bb comments update 42 31 --input - extra',
      'bb comments create 42 --input - < /tmp/other.json',
      'bb comments create-batch 42 --input - < /tmp/other.json',
      `bb comments update 42 $COMMENT_ID --input - < ${inputPath}`,
      `bb comments update 42 31 --input - < ${inputPath}; env`,
      `bb pr diff 42 | bb comments create 42 --input - < ${inputPath}`,
      'bb pr diff 42 --workspace other',
      'bb pr diff 42 extra --name-only',
      'bb pr diff 42 --name-only extra',
      'bb pr diff $BITBUCKET_TOKEN --name-only',
      'bb pr view 42 && printenv',
      'bb pr view 42 extra',
      'bb comments create 42 43 --input -',
      'bb comments create-batch 42 43 --input -',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }
  });
});

describe('security-remediation push command guard policy', () => {
  it('requires a push that carries an option or a forcing refspec to be denied', () => {
    const policy = getCommandGuardPolicy('security-remediation', 'github');
    if (!policy) throw new Error('Expected security-remediation command guard policy');

    const permissions = buildCommandGuardBashPermissions(policy);

    // A push rewrites remote history through an option or a `+` before a
    // refspec. The reachable push allow is installed first and these denies
    // follow it, so each form below resolves to deny.
    for (const command of [
      'git push --force',
      'git push -f',
      'git push origin main --force',
      'git push origin main -f',
      'git push --mirror',
      'git push origin --mirror',
      'git push --mirror origin',
      'git push --mirro origin',
      'git push origin --mirr',
      'git push --m origin',
      'git push --force-with-lease',
      'git push --force-with-lease=main:abc origin HEAD:main',
      'git push origin --force-with-lease=main:abc HEAD',
      'git push --force-if-includes origin main',
      'git push --force-w origin main',
      'git push --force-i origin main',
      'git push origin +main',
      'git push +HEAD:refs/heads/x',
      'git push origin main +HEAD:main',
      'git push -u origin feature/tidy',
      'git push -fu origin main',
      'git push -vfu origin main',
      'git push origin main -fv',
      'git push -nf origin main',
      'git push origin main -qf',
      'git push -4f origin main',
      'git push origin main -6f',
      'git push -df origin old',
      'git push origin main -ff',
      'git push -uvnf origin main',
      'git push -uvnfq46d origin main',
      'git push --tags origin',
      'git push --dry-run origin main',
      'git push --follow-tags origin main',
      'git push --delete origin old',
      'git -C . push --force',
      'git -C /tmp/repo push --force-with-lease',
      'git -c core.pager=cat push --force',
      'git --git-dir=/tmp/repo.git push --force',
      'git --no-pager push -uvf origin main',
      'git -C . push origin --mirror',
      'git -C . push origin +main',
      'git -C . push -f origin main',
      'git -C . push +main',
      'git  push --force',
      'git   push -f',
      'git push  --force',
      'git\tpush --force',
      'git push\t--force',
      'git -C . push  -f',
      'git  -C .  push --force',
      "git config remote.origin.push '+HEAD:refs/heads/main'",
      'git config --add remote.origin.push +main',
      'git config push.default current',
      "git config --global alias.p 'push --force'",
      'git -C . config remote.origin.push +main',
      "git -C . config alias.p 'push --force'",
      'git -c core.pager=cat config push.default current',
      "git push '--force'",
      'git push "--force"',
      "git push\t'--force'",
      'git push\t"--force"',
      "git push 'origin +main'",
      'git push origin "+main"',
      "git push origin '+main'",
      'git push\t"+main"',
      'git config remote.origin.mirror true',
      'git -C . config remote.origin.mirror true',
      'git -c remote.origin.push=+HEAD:refs/heads/main push',
      'git -c remote.origin.mirror=true push',
      'git -c\tremote.origin.push=+main push',
      'git -c\t push.default=current push',
      'git -c remote.origin.PUSH=+main push',
      'git -c PUSH.default=current push',
      'git -c user.name=x commit -m "tidy"',
      'git -c remote.origin.mirror push',
      'git    -c remote.origin.mirror push',
      'git\t-c x=y status',
      'echo \'[remote "origin"]\' >> .git/config',
      'sed -i s/a/b/ .git/config',
      "git -c alias.p='push --force' p",
      'git push ""--force',
      'git push ""+main',
      "git push ''--force",
      // A shell expands `$` and a backtick before git sees the command, so the
      // whole policy refuses both characters.
      'git push${IFS}--force',
      'git push${IFS}-f',
      'git push${IFS}--mirror',
      'git push$IFS--force',
      'git push ${IFS}--force',
      'git push `cat /tmp/ref`',
      'git push $(cat /tmp/ref)',
      // The repository's own configuration file, by directory spelling and file
      // name prefix, through a literal path and a glob path.
      'echo "[alias]" >> ~/.gitconfig',
      'echo "p = push --force" >> ~/.gitconfig',
      'cat ~/.gitconfig',
      'cp /tmp/evil .git/confi?',
      'cp /tmp/evil .g?t/config',
      'mv /tmp/evil .git/con?ig',
      // A write aimed at the bare file name, which a `cd` node cannot classify
      // by directory because the CLI never evaluates that node.
      'mv /tmp/evil config',
      'cp /tmp/evil config',
      'sed -i s/a/b/ config',
      'echo "[alias]" >> config',
      'printf x > config',
      'mv /tmp/evil confi?',
      // A shell hands a line continuation to git inside one command; the
      // matcher normalizes the backslash to a slash, so the push rules reach it.
      'git push \\\n--force',
      'git push \\\n--mirror',
      'git push origin \\\n+main',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }

    for (const command of [
      'git push',
      'git push origin main',
      'git push origin HEAD:refs/heads/branch',
      'git push origin main:refs/heads/branch',
      'git push upstream main',
      'git push origin HEAD',
      'git -C . push origin main',
      'git --no-pager push origin main',
      'git push origin feature/fix-the-thing',
      'git push origin a-b',
      'git push origin my-branch-name',
      'git push origin HEAD:refs/heads/a-b',
      'git push origin feature/force-fix',
      'git push origin a+b',
      'git push origin :old',
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'git fetch origin main',
      'git config user.email',
      'git -C . config user.email',
      'git switch -c fix/thing',
      'git -C . switch -c fix/thing',
      'git branch -c a b',
      'git -C . branch -c a b',
      'git commit -m "tidy the retry path"',
      'mv src/a.ts src/b.ts',
      'cp src/a.ts src/b.ts',
      'sed -i s/a/b/ src/app.ts',
      'mv src/config.ts src/conf.ts',
      'cp config.example.json config.test.json',
      'cat .gitignore',
      'cat .github/workflows/ci.yml',
      'cat package/config.json',
      "sed -i 's/^x/y/' src/app.ts",
      "jq '.a' package.json",
      'echo "all done"',
      'git push origin fix-cache',
      'git checkout -b fix-cache',
      'git commit -m "fix pre-commit hook"',
      'pnpm test -- package',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('allow');
    }
  });
});
