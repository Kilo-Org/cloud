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

    expect(bashPermissions['git']).toBe('allow');
    expect(bashPermissions['git *']).toBe('allow');
    expect(bashPermissions['git fetch']).toBe('allow');
    expect(bashPermissions['git fetch *']).toBe('allow');
    expect(bashPermissions['git pull']).toBe('allow');
    expect(bashPermissions['git pull *']).toBe('allow');
    expect(bashPermissions['git push']).toBe('deny');
    expect(bashPermissions['git push *']).toBe('deny');
    expect(bashPermissions['git commit']).toBe('deny');
    expect(bashPermissions['git commit *']).toBe('deny');
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
