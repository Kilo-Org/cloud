import { describe, expect, it } from 'vitest';
import { buildBuiltinAgentEntries } from './runtime-profile-config.js';
import { RuntimeBuiltinAgentsSchema } from './runtime-profile.js';
import {
  buildCommandGuardBashPermissions,
  getCommandGuardPolicy,
} from '../session/command-guard.js';
import {
  matchesKiloPermissionPattern,
  narrowProfileAgents,
  narrowProfilePermission,
  type PermissionMap,
} from './profile-permission-policy.js';

function resolve(session: PermissionMap, composed: PermissionMap, tool: string, command: string) {
  const rules = [session[tool], composed[tool]].flatMap(value =>
    typeof value === 'string'
      ? [{ pattern: '*', action: value }]
      : typeof value === 'object'
        ? Object.entries(value).map(([pattern, action]) => ({ pattern, action }))
        : []
  );
  let action: string | undefined;
  for (const rule of rules) {
    if (matchesKiloPermissionPattern(command, rule.pattern)) action = rule.action;
  }
  return action;
}

const reviewSession: PermissionMap = {
  edit: 'deny',
  bash: {
    '*': 'deny',
    'gh pr diff': 'allow',
    'gh pr diff *': 'allow',
    'git log': 'allow',
    'git log *': 'allow',
    'git push': 'deny',
    'git push *': 'deny',
  },
  webfetch: 'deny',
  todowrite: 'allow',
};

describe('narrowProfilePermission', () => {
  it('drops a flat allow when the session sets a restriction', () => {
    expect(narrowProfilePermission(reviewSession, 'allow')).toBeUndefined();
  });

  it('keeps a flat denial', () => {
    expect(narrowProfilePermission(reviewSession, 'deny')).toBe('deny');
  });

  it('keeps a tool that the session denies denied, and a tool the session leaves alone at its value', () => {
    expect(
      narrowProfilePermission(reviewSession, { edit: 'allow', webfetch: 'allow', read: 'allow' })
    ).toEqual({ read: 'allow' });
  });

  it('keeps a stricter tool denial and the session allow for another tool', () => {
    expect(narrowProfilePermission(reviewSession, { edit: 'deny', todowrite: 'allow' })).toEqual({
      edit: 'deny',
      todowrite: 'allow',
    });
  });

  it('refuses the denied command and omits allowances the session does not write', () => {
    const narrowed = narrowProfilePermission(reviewSession, {
      bash: { 'git log --oneline': 'allow', 'git push origin main': 'allow', npm: 'deny' },
    });
    // Neither allowance repeats a session pattern, so both are omitted; the
    // profile refusal applies as written.
    expect(narrowed).toEqual({ bash: { npm: 'deny' } });
  });

  it('keeps an agent allowance the session writes and omits one it does not', () => {
    // The profile's other allowance has no session entry, and the session's
    // refusals are written before the kept allowance or name a command it
    // cannot cover, so only the allowance the session writes is kept and the
    // session's own verdicts still govern.
    expect(
      narrowProfilePermission(reviewSession, { bash: { 'git log *': 'allow', 'ls *': 'allow' } })
    ).toEqual({
      bash: { 'git log *': 'allow' },
    });
    expect(narrowProfilePermission(reviewSession, { bash: { '*': 'allow' } })).toBeUndefined();
  });

  it('keeps a stricter denial for a pattern the session permits', () => {
    const session: PermissionMap = {
      bash: { '*': 'deny', 'git status': 'allow', 'git status *': 'allow' },
    };
    expect(
      narrowProfilePermission(session, { bash: { 'git status *': 'deny', 'git log *': 'allow' } })
    ).toEqual({ bash: { 'git status *': 'deny' } });
  });

  it('keeps a profile refusal and the exception the session writes after it', () => {
    const session: PermissionMap = {
      bash: { find: 'allow', 'find *': 'allow', 'find *-delete*': 'deny' },
    };
    // The profile refuses every command and permits the one the session permits;
    // the session's refusal for the delete form follows it.
    expect(narrowProfilePermission(session, { bash: { '*': 'deny', 'find *': 'allow' } })).toEqual({
      bash: { '*': 'deny', 'find *': 'allow', 'find *-delete*': 'deny' },
    });
  });

  it('applies the session verdicts for the commands a kept allowance covers', () => {
    const session: PermissionMap = {
      bash: {
        find: 'allow',
        'find *': 'allow',
        'find *-delete*': 'deny',
        'git status': 'allow',
      },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'find *': 'allow' },
    }) as PermissionMap;
    // The refusal written after the allowance follows it, so it decides the
    // delete form; the session's later allow for another command covers no
    // command of this allowance and is left out.
    expect(Object.keys(composed['bash'] as Record<string, string>)).toEqual([
      'find *',
      'find *-delete*',
    ]);
    expect(resolve(session, composed, 'bash', 'find . -name x')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'find . -name x -delete')).toBe('deny');
    expect(resolve(session, composed, 'bash', 'git status')).toBe('allow');
  });

  it('leaves out a session refusal written before the allowance', () => {
    const session: PermissionMap = {
      bash: {
        'git *': 'deny',
        'git log': 'allow',
        'git log *': 'allow',
        'git log *--output*': 'deny',
        'git push': 'deny',
      },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'git log *': 'allow' },
    }) as PermissionMap;
    // The broad git refusal is written before the allowance, so it is not
    // carried and the session's allows keep deciding the read forms; a refusal
    // the session writes after the allowance is carried, and the session still
    // denies the output form itself.
    expect(Object.keys(composed['bash'] as Record<string, string>)).toEqual([
      'git log *',
      'git log *--output*',
    ]);
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git log --output=/tmp/x')).toBe('deny');
    expect(resolve(session, composed, 'bash', 'git push origin main')).toBe('deny');
  });

  it('carries the session refusals for commands inside a kept allowance', () => {
    const session: PermissionMap = {
      bash: {
        find: 'allow',
        'find *': 'allow',
        'find *-delete*': 'deny',
        'git status': 'allow',
      },
    };
    // The guard refuses a form of find after permitting find, so the refusal
    // follows the allowance in the composed map; the session's later allow for
    // another command is not carried.
    expect(narrowProfilePermission(session, { bash: { 'find *': 'allow' } })).toEqual({
      bash: { 'find *': 'allow', 'find *-delete*': 'deny' },
    });
  });

  it('carries a session refusal whose glob overlaps a kept allowance', () => {
    const session: PermissionMap = {
      bash: { 'git log *': 'allow', 'git *--output*': 'deny' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'git log *': 'allow' },
    }) as PermissionMap;
    // The refusal names the output option in another position than the
    // allowance, so neither pattern's text satisfies the other and only the
    // overlapping globs and the rule order carry it.
    expect(composed['bash']).toEqual({ 'git log *': 'allow', 'git *--output*': 'deny' });
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git log --output=/tmp/x')).toBe('deny');
  });

  it('carries the shell syntax refusals that a kept allowance covers', () => {
    const session: PermissionMap = {
      bash: { ls: 'allow', 'ls *': 'allow', '*$*': 'deny', '*>*': 'deny' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'ls *': 'allow' },
    }) as PermissionMap;
    // The guard refuses the shell syntax a permitted command can carry, and each
    // refusal's glob reaches the allowance, so it follows the allowance.
    expect(composed['bash']).toEqual({
      'ls *': 'allow',
      '*$*': 'deny',
      '*>*': 'deny',
    });
    expect(resolve(session, composed, 'bash', 'ls -la')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'ls $(id)')).toBe('deny');
    expect(resolve(session, composed, 'bash', 'ls -la > /tmp/x')).toBe('deny');
  });

  it('carries a session refusal written with a leading wildcard', () => {
    const session: PermissionMap = {
      bash: { 'find *': 'allow', '*|*': 'deny', 'git log *': 'allow' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'find *': 'allow' },
    }) as PermissionMap;
    const bash = composed['bash'] as Record<string, string>;
    // The refusal starts with a wildcard, so its glob can cover the allowance and
    // it is carried even though the session writes a later allow for another
    // command.
    expect(bash['*|*']).toBe('deny');
    expect(resolve(session, composed, 'bash', 'find x')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'find x | cat')).toBe('deny');
  });

  it('skips a refusal that a later session allow provably covers', () => {
    const session: PermissionMap = {
      bash: { 'find *': 'allow', 'find *-delete*': 'deny', 'find *-delete* *': 'allow' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'find *': 'allow' },
    }) as PermissionMap;
    // The session writes an allow for the refused form after the refusal, and
    // that allow decides the refusal's own pattern, so the refusal is skipped
    // and both forms stay allowed.
    expect(composed['bash']).toEqual({ 'find *': 'allow' });
    expect(resolve(session, composed, 'bash', 'find . -delete')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'find . -name x')).toBe('allow');
  });

  it('does not drop a refusal for a matching-looking allow', () => {
    const session: PermissionMap = {
      bash: { 'a*': 'allow', 'a*c': 'deny', 'a?c': 'allow' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'a*': 'allow' },
    }) as PermissionMap;
    // The later allow's glob takes the refusal's pattern text, because `?`
    // accepts the literal `*`, but it matches no command with two characters
    // between the `a` and the `c`, so the refusal still decides `abbc`.
    expect(composed['bash']).toEqual({ 'a*': 'allow', 'a*c': 'deny' });
    expect(resolve(session, composed, 'bash', 'abbc')).toBe('deny');
  });

  it('drops a refusal a later allow of the same pattern covers', () => {
    const session: PermissionMap = {
      bash: { 'a*b': 'allow', 'a*bc': 'deny', 'a*bc*': 'allow' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'a*b': 'allow' },
    }) as PermissionMap;
    // The later allow matches every command the refusal names, so it decides
    // them on its own and the refusal is left out of the composed map.
    expect(resolve(session, composed, 'bash', 'axbc')).toBe('allow');
    expect(Object.keys(composed['bash'] as Record<string, string>)).not.toContain('a*bc');
  });

  it('carries the bitbucket shell syntax refusals for a permitted command', () => {
    const policy = getCommandGuardPolicy('code-review', 'bitbucket', 'review-1')!;
    const session: PermissionMap = { bash: buildCommandGuardBashPermissions(policy) };
    const composed = narrowProfilePermission(session, {
      bash: { 'bb pr diff *': 'allow' },
    }) as PermissionMap;
    // The guard permits the diff read and refuses the shell syntax written after
    // it, so every shell form of the permitted command stays refused.
    expect(resolve(session, composed, 'bash', 'bb pr diff x')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'bb pr diff x | cat')).toBe('deny');
    expect(resolve(session, composed, 'bash', 'bb pr diff x > out')).toBe('deny');
  });

  it('keeps a profile catch-all refusal over a later session allow', () => {
    const session: PermissionMap = {
      bash: { find: 'allow', 'find *': 'allow', 'find *-delete*': 'deny', 'git status': 'allow' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { '*': 'deny', 'find *': 'allow' },
    }) as PermissionMap;
    // The profile refuses every command and permits the one the session
    // permits, so the session's allow for another command is not carried and
    // the catch-all refusal keeps deciding every command the profile did not
    // name.
    expect(composed['bash']).toEqual({
      '*': 'deny',
      'find *': 'allow',
      'find *-delete*': 'deny',
    });
    expect(resolve(session, composed, 'bash', 'find . -name x')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'find . -delete')).toBe('deny');
    expect(resolve(session, composed, 'bash', 'git status')).toBe('deny');
  });

  it('leaves the session refusals for other commands out of a kept allowance', () => {
    const session: PermissionMap = {
      bash: {
        find: 'allow',
        'find *': 'allow',
        git: 'deny',
        'git log': 'allow',
        'git log *': 'allow',
      },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'find *': 'allow' },
    }) as PermissionMap;
    // The refusal names a command the allowance cannot cover, so it is left
    // out; the session's own later allow for git log keeps deciding.
    expect(composed['bash']).toEqual({ 'find *': 'allow' });
    expect(resolve(session, composed, 'bash', 'find . -name x')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('allow');
  });

  it('carries every refusal the allowance can reach when the session has no later exception', () => {
    const session: PermissionMap = {
      bash: { 'git log *': 'allow', 'git *--output*': 'deny', 'git *--no-pager*': 'deny' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'git log *': 'allow' },
    }) as PermissionMap;
    // The session writes no exception, so both refusals follow the allowance and
    // the read form still passes over them.
    expect(composed['bash']).toEqual({
      'git log *': 'allow',
      'git *--output*': 'deny',
      'git *--no-pager*': 'deny',
    });
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git log --output=/tmp/x')).toBe('deny');
  });

  it('keeps an agent ask as written and carries the session decisions it reaches', () => {
    // A session that says nothing about the tool leaves the ask as written.
    expect(narrowProfilePermission({ edit: 'deny' }, { bash: { '*': 'ask' } })).toEqual({
      bash: { '*': 'ask' },
    });
    // The session's own refusal on the ask's key is carried after the ask, and
    // every session allow the ask covers becomes the profile's ask, so a
    // refusal the session wrote stays a refusal.
    const composed = narrowProfilePermission(reviewSession, {
      bash: { '*': 'ask' },
    }) as PermissionMap;
    expect(composed['bash']).toEqual({
      '*': 'deny',
      'git push': 'deny',
      'git push *': 'deny',
      'gh pr diff': 'ask',
      'gh pr diff *': 'ask',
      'git log': 'ask',
      'git log *': 'ask',
    });
    expect(resolve(reviewSession, composed, 'bash', 'git log --oneline')).toBe('ask');
    expect(resolve(reviewSession, composed, 'bash', 'rm -rf /')).toBe('deny');
    // The ask keeps its own entry as written and the session's allows for the
    // same commands become asks, so the read form prompts while every other
    // command keeps the session's refusal.
    const narrow = narrowProfilePermission(reviewSession, {
      bash: { 'git log *': 'ask' },
    }) as PermissionMap;
    expect(narrow['bash']).toEqual({ 'git log *': 'ask', 'git log': 'ask' });
    expect(resolve(reviewSession, narrow, 'bash', 'git log --oneline')).toBe('ask');
    expect(resolve(reviewSession, narrow, 'bash', 'node x')).toBe('deny');
  });

  it('carries the session refusals an agent ask can reach', () => {
    const session: PermissionMap = {
      bash: { '*': 'deny', 'cat *': 'allow' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'gh pr diff *': 'ask' },
    }) as PermissionMap;
    // A session that delivers profile agents writes one rule per tool, so this
    // catch-all shape exists only for a map no profile agent reaches; it is kept
    // here to prove the composed entry stays within the session either way. The
    // refusal covers every command, so it is carried after the ask and the ask
    // decides nothing.
    expect(composed['bash']).toEqual({ 'gh pr diff *': 'ask', '*': 'deny' });
    expect(resolve(session, composed, 'bash', 'gh pr diff 1')).toBe('deny');
    expect(resolve(session, composed, 'bash', 'cat x')).toBe('deny');
  });

  it('keeps a profile allowance that a narrower ask sits inside', () => {
    const session: PermissionMap = {
      bash: buildCommandGuardBashPermissions(
        getCommandGuardPolicy('security-remediation', 'github')!
      ),
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'git *': 'allow', 'git push *': 'ask' },
    }) as PermissionMap;
    // The ask reaches only the push form, so the session's wider git allow keeps
    // its own effect for the reads the profile allows.
    expect(resolve(session, composed, 'bash', 'git status')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git push origin main')).toBe('ask');
  });

  it('renders the session refusal after an ask written on the same pattern', () => {
    const session: PermissionMap = { bash: { '*': 'deny' } };
    // The ask is kept on its own key, and the session's refusal on that same key
    // follows it, so the last decision is the refusal and no prompt survives.
    const composed = narrowProfilePermission(session, { bash: { '*': 'ask' } }) as PermissionMap;
    expect(composed).toEqual({ bash: { '*': 'deny' } });
    expect(resolve(session, composed, 'bash', 'rm -rf /')).toBe('deny');
    expect(resolve(session, composed, 'bash', 'npm test')).toBe('deny');
  });

  it('does not carry a wider session allow into an ask', () => {
    const session: PermissionMap = { bash: { git: 'allow', 'git *': 'allow' } };
    const composed = narrowProfilePermission(session, {
      bash: { 'git push *': 'ask' },
    }) as PermissionMap;
    // The session's allows are wider than the ask, so they stay out of the
    // composed map and keep their own effect; the ask decides the push form.
    expect(composed['bash']).toEqual({ 'git push *': 'ask' });
    expect(resolve(session, composed, 'bash', 'git status')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git push origin main')).toBe('ask');
  });

  it('does not carry a session allow that reaches past the ask', () => {
    const session: PermissionMap = { bash: { 'a*c': 'allow' } };
    const composed = narrowProfilePermission(session, {
      bash: { 'a?c': 'ask' },
    }) as PermissionMap;
    // The session's allow reaches commands the ask does not name, so it stays
    // out of the composed map and those commands keep the session's verdict.
    expect(composed['bash']).toEqual({ 'a?c': 'ask' });
    expect(resolve(session, composed, 'bash', 'axc')).toBe('ask');
    expect(resolve(session, composed, 'bash', 'abbc')).toBe('allow');
  });

  it('does not let an agent ask widen a flat session denial', () => {
    const session: PermissionMap = { bash: 'deny' };
    const composed = narrowProfilePermission(session, { bash: { '*': 'ask' } }) as PermissionMap;
    // The session's flat refusal covers every command of the tool and names the
    // ask's own pattern, so it is carried after the ask and no prompt survives.
    expect(composed).toEqual({ bash: { '*': 'deny' } });
    expect(resolve(session, composed, 'bash', 'npm test')).toBe('deny');
  });

  it('keeps an agent ask over a session allow for the same tool', () => {
    const session: PermissionMap = { bash: 'allow' };
    const composed = narrowProfilePermission(session, {
      bash: { '*': 'ask', 'rm *': 'deny' },
    }) as PermissionMap;
    // The session allows every command, so the profile's ask stands as written
    // and its own refusal still decides the destructive form.
    expect(resolve(session, composed, 'bash', 'ls -la')).toBe('ask');
    expect(resolve(session, composed, 'bash', 'rm -rf /')).toBe('deny');
  });

  it('carries the session refusals that follow a kept allowance', () => {
    const session: PermissionMap = {
      bash: buildCommandGuardBashPermissions(getCommandGuardPolicy('code-review', 'github')!),
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'find *': 'allow' },
    }) as PermissionMap;
    // The guard permits find and refuses the options that run another program,
    // so each refusal follows the allowance that reaches it.
    expect(composed['bash']).toMatchObject({ 'find *': 'allow', 'find *-delete*': 'deny' });
    expect(resolve(session, composed, 'bash', 'find . -name x')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'find . -name x -delete')).toBe('deny');
  });

  it('keeps the profile ask over a session allow it covers', () => {
    const session: PermissionMap = {
      bash: { '*': 'deny', 'git log': 'allow', 'git log *': 'allow' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { '*': 'ask' },
    }) as PermissionMap;
    // The session's allows satisfy the ask's pattern, so each is carried as the
    // profile's ask; the session's refusal on the ask's own key follows the ask
    // and keeps the rest refused.
    expect(composed['bash']).toEqual({
      '*': 'deny',
      'git log': 'ask',
      'git log *': 'ask',
    });
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('ask');
    expect(resolve(session, composed, 'bash', 'rm -rf /')).toBe('deny');
    expect(resolve(session, composed, 'bash', 'npm test')).toBe('deny');
  });

  it('does not carry a session allow wider than the ask', () => {
    const session: PermissionMap = {
      bash: {
        'gh api repos/*/pulls/*/reviews': 'allow',
        'gh api repos/*/pulls/*/reviews --input*': 'allow',
      },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'gh api repos/*/pulls/*/reviews --input*': 'ask' },
    }) as PermissionMap;
    // The wider allow does not satisfy the ask's pattern, so it keeps its own
    // verdict; the allow that repeats the ask's pattern is the ask itself.
    expect(composed['bash']).toEqual({ 'gh api repos/*/pulls/*/reviews --input*': 'ask' });
    expect(resolve(session, composed, 'bash', 'gh api repos/o/r/pulls/1/reviews')).toBe('allow');
    expect(
      resolve(session, composed, 'bash', 'gh api repos/o/r/pulls/1/reviews --input p.json')
    ).toBe('ask');
  });

  it('keeps the profile ask for git reads in a review session', () => {
    const session: PermissionMap = {
      bash: buildCommandGuardBashPermissions(getCommandGuardPolicy('code-review', 'github')!),
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'git *': 'ask' },
    }) as PermissionMap;
    // The guard refuses every git form and permits the read subcommands it
    // names, so each permitted read becomes an ask while every other command
    // keeps the guard's refusal.
    const bash = composed['bash'] as Record<string, string>;
    expect(bash['git *']).toBe('deny');
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('ask');
    expect(resolve(session, composed, 'bash', 'git status')).toBe('ask');
    expect(resolve(session, composed, 'bash', 'git diff')).toBe('ask');
    expect(resolve(session, composed, 'bash', 'rm -rf /')).toBe('deny');
  });

  it('carries a session allow for a pattern the profile does not name in either profile key order', () => {
    const session: PermissionMap = {
      bash: { '*': 'deny', 'git log': 'allow', 'git log *': 'allow' },
    };
    const expected = {
      '*': 'deny',
      'git *': 'ask',
      'git log': 'ask',
      'git log *': 'ask',
      'rm *': 'deny',
    };
    const askFirst = narrowProfilePermission(session, {
      bash: { 'git *': 'ask', 'rm *': 'deny' },
    }) as PermissionMap;
    const refusalFirst = narrowProfilePermission(session, {
      bash: { 'rm *': 'deny', 'git *': 'ask' },
    }) as PermissionMap;
    expect(askFirst['bash']).toEqual(expected);
    expect(refusalFirst['bash']).toEqual(expected);
    // The session refuses every command and its refusal is carried after the
    // asks, so it settles every command the asks reach, whatever their order.
    for (const composed of [askFirst, refusalFirst]) {
      expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('deny');
      expect(resolve(session, composed, 'bash', 'git status')).toBe('deny');
      expect(resolve(session, composed, 'bash', 'rm -rf /')).toBe('deny');
    }
  });

  it('keeps the profile verdict for a pattern the profile decides when an ask covers it', () => {
    const session: PermissionMap = { bash: { 'git log *': 'allow' } };
    const refusal = narrowProfilePermission(session, {
      bash: { 'git log *': 'deny', 'git *': 'ask' },
    }) as PermissionMap;
    const allowance = narrowProfilePermission(session, {
      bash: { 'git log *': 'allow', 'git *': 'ask' },
    }) as PermissionMap;
    expect(refusal['bash']).toEqual({ 'git log *': 'deny', 'git *': 'ask' });
    expect(allowance['bash']).toEqual({ 'git log *': 'allow', 'git *': 'ask' });
    // The profile decides the kept pattern, so its verdict settles the command
    // and the ask decides only the commands the profile named no rule for.
    expect(resolve(session, refusal, 'bash', 'git log --oneline')).toBe('deny');
    expect(resolve(session, refusal, 'bash', 'git status')).toBe('ask');
    expect(resolve(session, allowance, 'bash', 'git log --oneline')).toBe('allow');
    expect(resolve(session, allowance, 'bash', 'git status')).toBe('ask');
  });

  it('drops an empty agent map', () => {
    expect(narrowProfilePermission(reviewSession, {})).toBeUndefined();
    expect(narrowProfilePermission(reviewSession, { bash: {} })).toBeUndefined();
  });

  it('composes a pattern map against a flat session action', () => {
    // A flat denial covers every pattern, so an agent allowance for any pattern
    // of that tool is omitted and the session policy governs the tool.
    expect(narrowProfilePermission({ edit: 'deny' }, { edit: { '*': 'allow' } })).toBeUndefined();
    expect(
      narrowProfilePermission({ edit: 'deny' }, { edit: { '*': 'allow', 'notes.txt': 'deny' } })
    ).toEqual({ edit: { 'notes.txt': 'deny' } });
    expect(narrowProfilePermission({ webfetch: 'ask' }, { webfetch: { '*': 'allow' } })).toBe(
      undefined
    );
  });

  it('keeps a pattern map against a flat session allow, including its own denials', () => {
    expect(
      narrowProfilePermission({ bash: 'allow' }, { bash: { '*': 'allow', 'rm *': 'deny' } })
    ).toEqual({ bash: { '*': 'allow', 'rm *': 'deny' } });
  });

  it('keeps a flat ask action only where the session denies nothing', () => {
    expect(narrowProfilePermission({}, 'ask')).toBe('ask');
    expect(narrowProfilePermission({ todowrite: 'allow' }, 'ask')).toBe('ask');
    // A prompt where the session refuses a tool would be wider than the session.
    expect(narrowProfilePermission({ edit: 'deny' }, 'ask')).toBeUndefined();
    expect(narrowProfilePermission({ bash: { '*': 'deny' } }, 'ask')).toBeUndefined();
    expect(narrowProfilePermission({ edit: 'deny' }, 'allow')).toBeUndefined();
    expect(narrowProfilePermission({}, 'allow')).toBe('allow');
  });

  it('ignores a rule value that carries no action and keeps the rest of the tool', () => {
    expect(
      narrowProfilePermission({ bash: 'allow' }, {
        bash: { 'rm *': 'deny', 'cp *': null },
      } as unknown as Record<string, unknown>)
    ).toEqual({ bash: { 'rm *': 'deny' } });
  });

  it('keeps an entry for a tool the session does not mention', () => {
    expect(narrowProfilePermission({ edit: 'deny' }, { todowrite: 'allow' })).toEqual({
      todowrite: 'allow',
    });
    expect(narrowProfilePermission({ edit: 'deny' }, { todowrite: 'ask' })).toEqual({
      todowrite: 'ask',
    });
  });

  it('orders a narrower refusal after the broader ask in either profile key order', () => {
    const session: PermissionMap = { bash: { 'git log *': 'allow' } };
    const expectedKeys = ['git *', 'git log *'];
    for (const agent of [
      { bash: { 'git *': 'ask', 'git log *': 'deny' } },
      { bash: { 'git log *': 'deny', 'git *': 'ask' } },
    ]) {
      const composed = narrowProfilePermission(session, agent) as PermissionMap;
      expect(Object.keys(composed['bash'] as Record<string, string>)).toEqual(expectedKeys);
      expect((composed['bash'] as Record<string, string>)['git log *']).toBe('deny');
      expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('deny');
    }
  });

  it('lets a narrower profile allowance outrank a broader profile refusal', () => {
    const session: PermissionMap = { bash: { 'git log *': 'allow' } };
    const composed = narrowProfilePermission(session, {
      bash: { '*': 'deny', 'git log *': 'allow' },
    }) as PermissionMap;
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'npm test')).toBe('deny');
  });

  it('lets a narrower profile ask outrank a broader profile refusal', () => {
    const session: PermissionMap = { bash: { 'git *': 'allow' } };
    const composed = narrowProfilePermission(session, {
      bash: { '*': 'deny', 'git *': 'ask' },
    }) as PermissionMap;
    // The narrower rule is the profile's most specific decision, so the ask
    // settles the commands it reaches and the refusal keeps the rest.
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('ask');
    expect(resolve(session, composed, 'bash', 'npm test')).toBe('deny');
  });

  it('settles two overlapping patterns that contain neither other by their order', () => {
    const session: PermissionMap = { bash: { '*': 'allow', 'git p*': 'allow' } };
    const composed = narrowProfilePermission(session, {
      bash: { 'git p*': 'allow', '* push': 'ask', 'git *': 'deny' },
    }) as PermissionMap;
    // `git p*` and `* push` overlap without containing each other, so only the
    // composed order can settle a command that matches both. The wider `git *`
    // refusal contains `git p*`, which places `git *` before it.
    expect(resolve(session, composed, 'bash', 'git push')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git pull')).toBe('allow');
  });

  it('keeps a session refusal as the last word over a profile ask', () => {
    const session: PermissionMap = { bash: { '*': 'deny', 'cat *': 'allow' } };
    const composed = narrowProfilePermission(session, {
      bash: { 'gh pr diff *': 'ask' },
    }) as PermissionMap;
    // The session refusal covers every command, so it is carried after the ask
    // and the ask decides nothing, whatever the ask's own breadth is.
    expect((composed['bash'] as Record<string, string>)['*']).toBe('deny');
    expect(resolve(session, composed, 'bash', 'gh pr diff 1')).toBe('deny');
  });
});

describe('narrowProfileAgents', () => {
  const agent = {
    slug: 'reviewer',
    name: 'Reviewer',
    config: { mode: 'primary' as const, permission: { edit: 'allow' as const } },
  };

  it('narrows every agent and leaves the others untouched', () => {
    const [narrowed, untouched] = narrowProfileAgents(reviewSession, [
      agent,
      { slug: 'plain', name: 'Plain', config: { mode: 'subagent' as const } },
    ]);
    expect(narrowed?.config.permission).toBeUndefined();
    expect(untouched?.config).toEqual({ mode: 'subagent' });
  });

  it('keeps the profile restrictions that are stricter than the session', () => {
    const [narrowed] = narrowProfileAgents(reviewSession, [
      { ...agent, config: { ...agent.config, permission: { edit: 'deny', todowrite: 'allow' } } },
    ]);
    expect(narrowed?.config.permission).toEqual({ edit: 'deny', todowrite: 'allow' });
  });

  it('returns the agents unchanged for a session without a policy', () => {
    expect(narrowProfileAgents({}, [agent])).toEqual([agent]);
  });
});

describe('built-in agent overrides', () => {
  it('cannot carry a permission map, so the session policy governs a built-in agent', () => {
    const parsed = RuntimeBuiltinAgentsSchema.safeParse({
      explore: { model: 'kilo/test-model', permission: { bash: { '*': 'allow' } } },
    });
    expect(parsed.success).toBe(false);
    expect(
      buildBuiltinAgentEntries({ explore: { model: 'kilo/test-model', disable: false } }).explore
    ).toEqual({ model: 'kilo/test-model' });
  });
});
