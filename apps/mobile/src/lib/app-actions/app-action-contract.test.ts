import { describe, expect, it } from 'vitest';

import {
  APP_ACTION_IDS,
  APP_ACTION_SLUGS,
  appActionHref,
  type AppActionRequest,
  type AppActionResult,
  appActionUrl,
  parseActionRepository,
  parseAppActionPayload,
  parseAppActionUrl,
  resolveNeedsInputHref,
} from './app-action-contract';

const REQUESTS: readonly AppActionRequest[] = [
  { action: 'StartAgent', prompt: 'fix the failing build', repository: 'octo/hello' },
  { action: 'StartAgent', prompt: '', sessionId: 'ses_1' },
  { action: 'OpenNeedsInput' },
  { action: 'OpenSession', sessionId: 'ses_2' },
  { action: 'OpenPullRequest', pullRequest: 'https://github.com/octo/hello/pull/7' },
];

describe('APP_ACTION_SLUGS', () => {
  it('names every action', () => {
    for (const id of APP_ACTION_IDS) {
      expect(APP_ACTION_SLUGS[id]).toMatch(/^[a-z][a-z-]*$/);
    }
  });
});

describe('AppActionResult', () => {
  it('carries the success and failure shapes the callers report', () => {
    const success: AppActionResult = {
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_1',
      href: '/(app)/agent-chat/ses_1',
      message: 'started',
    };
    const failure: AppActionResult = {
      ok: false,
      action: 'OpenSession',
      retryable: false,
      code: 'unknown-session',
      message: 'session not found',
    };
    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
    expect(failure.retryable).toBe(false);
  });
});

describe('appActionUrl / parseAppActionUrl', () => {
  it.each(REQUESTS)('round-trips $action in URL form', request => {
    expect(parseAppActionUrl(appActionUrl(request))).toEqual(request);
  });

  it.each(REQUESTS)('round-trips $action in scheme-less path form', request => {
    const path = appActionUrl(request).replace('kiloapp://', '');
    expect(parseAppActionUrl(path)).toEqual(request);
  });

  it('builds the canonical kiloapp URL', () => {
    expect(appActionUrl({ action: 'OpenSession', sessionId: 'ses_2' })).toBe(
      'kiloapp:///actions/open-session?sessionId=ses_2'
    );
    expect(appActionUrl({ action: 'OpenNeedsInput' })).toBe('kiloapp:///actions/open-needs-input');
  });
});

const NULL_URL_CASES: readonly (readonly [string, string])[] = [
  ['an empty string', ''],
  ['a blank string', '   '],
  ['a missing prompt', 'kiloapp:///actions/start-agent'],
  ['a blank prompt', 'kiloapp:///actions/start-agent?prompt='],
  ['a whitespace prompt', 'kiloapp:///actions/start-agent?prompt=%20%20'],
  ['a missing sessionId', 'kiloapp:///actions/open-session'],
  ['a blank sessionId', 'kiloapp:///actions/open-session?sessionId='],
  ['a key without a value', '/actions/open-session?sessionId'],
  ['a missing pullRequest', '/actions/open-pull-request'],
  ['a blank pullRequest', 'kiloapp:///actions/open-pull-request?pullRequest=%20'],
  ['an unknown slug', 'kiloapp:///actions/do-something'],
  ['a non-slug action id', 'kiloapp:///actions/StartAgent'],
  ['an extra path segment', 'kiloapp:///actions/start-agent/extra'],
  ['a missing actions segment', 'kiloapp:///start-agent?prompt=x'],
  ['a foreign host', 'https://example.com/actions/start-agent?prompt=x'],
];

describe('parseAppActionUrl rejects malformed input', () => {
  it.each(NULL_URL_CASES)('returns null for %s', (_label, raw) => {
    expect(parseAppActionUrl(raw)).toBeNull();
  });
});

describe('parseAppActionPayload', () => {
  it('parses the object form with an action id or a slug', () => {
    expect(parseAppActionPayload({ action: 'OpenNeedsInput' })).toEqual({
      action: 'OpenNeedsInput',
    });
    expect(parseAppActionPayload({ action: 'open-session', sessionId: 'ses_2' })).toEqual({
      action: 'OpenSession',
      sessionId: 'ses_2',
    });
    expect(
      parseAppActionPayload({ action: 'start-agent', prompt: 'go', repository: 'o/r' })
    ).toEqual({ action: 'StartAgent', prompt: 'go', repository: 'o/r' });
  });

  it('parses the JSON text form', () => {
    const text = JSON.stringify({
      action: 'OpenPullRequest',
      pullRequest: 'https://github.com/o/r/pull/7',
    });
    expect(parseAppActionPayload(text)).toEqual({
      action: 'OpenPullRequest',
      pullRequest: 'https://github.com/o/r/pull/7',
    });
  });

  it('allows a sessionId-only StartAgent', () => {
    expect(parseAppActionPayload({ action: 'StartAgent', sessionId: 'ses_1' })).toEqual({
      action: 'StartAgent',
      prompt: '',
      sessionId: 'ses_1',
    });
  });

  it('keeps a blank StartAgent as that action so its empty-prompt refusal reaches the caller', () => {
    // An OS caller named `START_AGENT`, so the payload is not unrecognized: the
    // action path classifies the empty required input and reports the contract's
    // non-retryable `empty-prompt` result back to it.
    expect(parseAppActionPayload({ action: 'start-agent', prompt: '   ' })).toEqual({
      action: 'StartAgent',
      prompt: '   ',
    });
    expect(parseAppActionPayload({ action: 'StartAgent' })).toEqual({
      action: 'StartAgent',
      prompt: '',
    });
    expect(parseAppActionPayload({ action: 'StartAgent', sessionId: ' ' })).toEqual({
      action: 'StartAgent',
      prompt: '',
    });
  });

  it('rejects an unknown action, blank other required fields and non-objects', () => {
    expect(parseAppActionPayload({ action: 'Nope' })).toBeNull();
    expect(parseAppActionPayload({ action: 'open-session', sessionId: ' ' })).toBeNull();
    expect(parseAppActionPayload('not json')).toBeNull();
    expect(parseAppActionPayload(null)).toBeNull();
    expect(parseAppActionPayload(7)).toBeNull();
  });
});

describe('appActionHref', () => {
  it('resolves a session through getAgentSessionPath', () => {
    expect(appActionHref({ action: 'OpenSession', sessionId: 'ses_1' })).toBe(
      '/(app)/agent-chat/ses_1'
    );
  });

  it('resolves a GitHub review link through providerPrRoutePath', () => {
    expect(
      appActionHref({ action: 'OpenPullRequest', pullRequest: 'https://github.com/o/r/pull/7' })
    ).toBe('/(app)/pr-review/o/r/7');
  });

  it('returns null for text that is not a review link', () => {
    expect(
      appActionHref({ action: 'OpenPullRequest', pullRequest: 'https://example.com/x' })
    ).toBeNull();
  });

  it('leaves OpenNeedsInput to resolveNeedsInputHref', () => {
    expect(appActionHref({ action: 'OpenNeedsInput' })).toBeNull();
  });

  it('needs the created session id for StartAgent', () => {
    expect(appActionHref({ action: 'StartAgent', prompt: 'go' })).toBeNull();
    expect(
      appActionHref({ action: 'StartAgent', prompt: 'go' }, { createdSessionId: 'ses_9' })
    ).toBe('/(app)/agent-chat/ses_9');
  });
});

describe('resolveNeedsInputHref', () => {
  it('opens the agents tab when nothing waits', () => {
    expect(resolveNeedsInputHref([])).toBe('/(app)/(tabs)/(2_agents)');
  });

  it('ignores rows whose status is not attention', () => {
    expect(resolveNeedsInputHref([{ id: 'ses_1', status: 'running', isAcked: false }])).toBe(
      '/(app)/(tabs)/(2_agents)'
    );
  });

  it('opens the only waiting session', () => {
    expect(resolveNeedsInputHref([{ id: 'ses_1', status: 'question', isAcked: false }])).toBe(
      '/(app)/agent-chat/ses_1'
    );
  });

  it('opens the agents tab when two sessions wait', () => {
    expect(
      resolveNeedsInputHref([
        { id: 'ses_1', status: 'question', isAcked: false },
        { id: 'ses_2', status: 'permission', isAcked: false },
      ])
    ).toBe('/(app)/(tabs)/(2_agents)');
  });

  it('does not count an acked row as waiting', () => {
    expect(resolveNeedsInputHref([{ id: 'ses_1', status: 'question', isAcked: true }])).toBe(
      '/(app)/(tabs)/(2_agents)'
    );
    expect(
      resolveNeedsInputHref([
        { id: 'ses_1', status: 'question', isAcked: true },
        { id: 'ses_2', status: 'permission', isAcked: false },
      ])
    ).toBe('/(app)/agent-chat/ses_2');
  });
});

describe('parseActionRepository', () => {
  it('parses a GitHub repository URL', () => {
    expect(parseActionRepository('https://github.com/o/r')).toEqual({
      kind: 'github',
      fullName: 'o/r',
    });
  });

  it('parses an ssh GitLab URL and keeps the subgroup path', () => {
    expect(parseActionRepository('git@gitlab.com:g/s/p.git')).toEqual({
      kind: 'gitlab',
      fullName: 'g/s/p',
    });
  });

  it('parses an https GitLab URL with subgroups', () => {
    expect(parseActionRepository('https://gitlab.com/g/s/p')).toEqual({
      kind: 'gitlab',
      fullName: 'g/s/p',
    });
  });

  it('accepts a bare owner/repo as GitHub', () => {
    expect(parseActionRepository('o/r')).toEqual({ kind: 'github', fullName: 'o/r' });
  });

  it('strips a .git suffix', () => {
    expect(parseActionRepository('https://github.com/o/r.git')).toEqual({
      kind: 'github',
      fullName: 'o/r',
    });
  });

  it('marks a Bitbucket repository unsupported — it needs the picker uuids', () => {
    expect(parseActionRepository('https://bitbucket.org/w/r')).toEqual({
      kind: 'unsupported',
      fullName: 'w/r',
    });
  });

  it('returns null for an unknown host, a blank value and an unusable path', () => {
    expect(parseActionRepository('https://example.com/o/r')).toBeNull();
    expect(parseActionRepository('   ')).toBeNull();
    expect(parseActionRepository('https://github.com/o')).toBeNull();
    expect(parseActionRepository('https://github.com/o/r/tree/main')).toBeNull();
    expect(parseActionRepository('o/r/extra')).toBeNull();
  });
});
