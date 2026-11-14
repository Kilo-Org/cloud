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

  it('keeps an inspection allow the session also permits and refuses the denied command', () => {
    const narrowed = narrowProfilePermission(reviewSession, {
      bash: { 'git log --oneline': 'allow', 'git push origin main': 'allow', npm: 'deny' },
    });
    expect(narrowed).toEqual({ bash: { npm: 'deny' } });
  });

  it('keeps an agent allowance the session writes and omits one it does not', () => {
    // The profile's other allowance has no session entry, and the session's
    // refusals name commands this allowance cannot cover, so only the allowance
    // the session writes is kept and the session's own verdicts still govern.
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
    // allowance, so no pattern text nests and only rule order carries it.
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
    // The refusal has no literal prefix, so it can cover the allowance and is
    // carried even though the session writes a later allow for another command.
    expect(bash['*|*']).toBe('deny');
    expect(resolve(session, composed, 'bash', 'find x')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'find x | cat')).toBe('deny');
  });

  it('carries every refusal the allowance can reach even when a later session allow exists', () => {
    const session: PermissionMap = {
      bash: { 'find *': 'allow', 'find *-delete*': 'deny', 'find *-delete* *': 'allow' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'find *': 'allow' },
    }) as PermissionMap;
    // The session's own allow for the delete form does not lift the refusal the
    // allowance reaches, so the delete form stays refused.
    expect(resolve(session, composed, 'bash', 'find . -delete')).toBe('deny');
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

  it('carries a refusal for every command a kept allowance covers when the session has no later exception', () => {
    const session: PermissionMap = {
      bash: { 'git log *': 'allow', 'git *--output*': 'deny', 'git *--no-pager*': 'deny' },
    };
    const composed = narrowProfilePermission(session, {
      bash: { 'git log *': 'allow' },
    }) as PermissionMap;
    // The session writes no exception, so both refusals follow the allowance
    // and the read form still passes over them.
    expect(composed['bash']).toEqual({
      'git log *': 'allow',
      'git *--output*': 'deny',
      'git *--no-pager*': 'deny',
    });
    expect(resolve(session, composed, 'bash', 'git log --oneline')).toBe('allow');
    expect(resolve(session, composed, 'bash', 'git log --output=/tmp/x')).toBe('deny');
  });

  it('keeps an agent ask as written', () => {
    expect(narrowProfilePermission({ edit: 'deny' }, { bash: { '*': 'ask' } })).toEqual({
      bash: { '*': 'ask' },
    });
    expect(narrowProfilePermission(reviewSession, { bash: { '*': 'ask' } })).toEqual({
      bash: { '*': 'ask' },
    });
    // An ask is stricter than an allowance, so it needs no session rules after it.
    expect(narrowProfilePermission(reviewSession, { bash: { 'git log *': 'ask' } })).toEqual({
      bash: { 'git log *': 'ask' },
    });
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

  it('keeps a flat ask action when the session sets no restriction', () => {
    expect(narrowProfilePermission({}, 'ask')).toBe('ask');
    expect(narrowProfilePermission({ todowrite: 'allow' }, 'ask')).toBe('ask');
    expect(narrowProfilePermission({ edit: 'deny' }, 'ask')).toBe('ask');
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
