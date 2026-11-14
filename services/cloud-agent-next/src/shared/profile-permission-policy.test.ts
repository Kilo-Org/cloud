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
      bash: { 'git log --oneline': 'allow', npm: 'deny' },
    });
  });

  it('keeps an inspection allow whose wider refusal the session overrides later', () => {
    const session: PermissionMap = {
      bash: { '*': 'deny', 'git status': 'allow', 'git status *': 'allow' },
    };
    expect(
      narrowProfilePermission(session, { bash: { 'git status': 'allow', 'git log *': 'allow' } })
    ).toEqual({ bash: { 'git status': 'allow' } });
  });

  it('omits an agent allowance that the session refuses', () => {
    expect(narrowProfilePermission(reviewSession, { bash: { '*': 'allow' } })).toBeUndefined();
  });

  it('omits an agent allowance a later session refusal covers', () => {
    const session: PermissionMap = {
      bash: { '*': 'deny', 'git *': 'allow', 'git push *': 'deny' },
    };
    // The session allows most git commands and refuses pushes, so an agent
    // allowance for all of git is wider than the session on pushes.
    expect(narrowProfilePermission(session, { bash: { 'git *': 'allow' } })).toBeUndefined();
    // An allowance the session permits for its whole range survives.
    expect(
      narrowProfilePermission(session, { bash: { 'git log *': 'allow', 'git push *': 'allow' } })
    ).toEqual({ bash: { 'git log *': 'allow' } });
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
    expect(narrowProfilePermission({ edit: 'deny' }, 'ask')).toBeUndefined();
  });

  it('ignores a rule value that carries no action and keeps the rest of the tool', () => {
    expect(
      narrowProfilePermission({ bash: 'allow' }, {
        bash: { '*': 'allow', 'rm *': null },
      } as unknown as Record<string, unknown>)
    ).toEqual({ bash: { '*': 'allow' } });
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
