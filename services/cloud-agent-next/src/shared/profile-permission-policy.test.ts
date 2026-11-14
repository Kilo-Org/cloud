import { describe, expect, it } from 'vitest';
import { buildBuiltinAgentEntries } from './runtime-profile-config.js';
import { RuntimeBuiltinAgentsSchema } from './runtime-profile.js';
import {
  narrowProfileAgents,
  narrowProfilePermission,
  type PermissionMap,
} from './profile-permission-policy.js';

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
    expect(narrowed).toEqual({
      bash: {
        'git log --oneline': 'allow',
        npm: 'deny',
        'git push': 'deny',
        'git push *': 'deny',
      },
    });
  });

  it('keeps a wildcard allow only where the session permits it, and carries the session refusals', () => {
    const narrowed = narrowProfilePermission(reviewSession, { bash: { '*': 'allow' } });
    expect(narrowed).toEqual({
      bash: {
        'git push': 'deny',
        'git push *': 'deny',
      },
    });
  });

  it('places the session refusal last so it decides over a surviving agent allowance', () => {
    const session: PermissionMap = {
      bash: { '*': 'deny', 'git *': 'allow', 'git push *': 'deny' },
    };
    const narrowed = narrowProfilePermission(session, { bash: { 'git *': 'allow' } });
    const bash = (narrowed as PermissionMap)?.['bash'] as Record<string, string>;
    expect(bash).toEqual({ 'git *': 'allow', 'git push *': 'deny' });
    // The session refusal is last, so it decides the push entry.
    const rules = Object.entries(bash);
    expect(rules[rules.length - 1]).toEqual(['git push *', 'deny']);
  });

  it('keeps the explicit allow exception inside a mixed global deny and read allow', () => {
    const session: PermissionMap = {
      bash: { '*': 'deny', 'git status': 'allow', 'git status *': 'allow' },
    };
    expect(
      narrowProfilePermission(session, { bash: { '*': 'allow', 'git status': 'allow' } })
    ).toEqual({ bash: { 'git status': 'allow' } });
  });

  it('drops an empty agent map', () => {
    expect(narrowProfilePermission(reviewSession, {})).toBeUndefined();
    expect(narrowProfilePermission(reviewSession, { bash: {} })).toBeUndefined();
  });

  it('narrows a pattern map against a flat session denial', () => {
    // The session denies edit as one flat action, so a map-shaped agent allow
    // must not re-enter the union unopposed.
    expect(narrowProfilePermission({ edit: 'deny' }, { edit: { '*': 'allow' } })).toEqual({
      edit: { '*': 'deny' },
    });
    expect(
      narrowProfilePermission({ edit: 'deny' }, { edit: { '*': 'allow', 'notes.txt': 'allow' } })
    ).toEqual({ edit: { '*': 'deny' } });
  });

  it('keeps a pattern map against a flat session allow, including its own denials', () => {
    expect(
      narrowProfilePermission({ bash: 'allow' }, { bash: { '*': 'allow', 'rm *': 'deny' } })
    ).toEqual({ bash: { '*': 'allow', 'rm *': 'deny' } });
  });

  it('narrows a pattern map against a flat session ask', () => {
    expect(narrowProfilePermission({ webfetch: 'ask' }, { webfetch: { '*': 'allow' } })).toEqual({
      webfetch: { '*': 'ask' },
    });
    expect(narrowProfilePermission({ webfetch: 'ask' }, { webfetch: { '*': 'deny' } })).toEqual({
      webfetch: { '*': 'deny' },
    });
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
