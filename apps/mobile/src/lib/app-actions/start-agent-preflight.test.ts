import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { preflightStartAgent } from './start-agent-preflight';

describe('preflightStartAgent', () => {
  it('accepts a request with a prompt and no repository, which falls back to the recent one', () => {
    expect(preflightStartAgent({ prompt: 'fix the build' })).toEqual({ ok: true, named: null });
  });

  it('accepts a session-only request, which continues that session', () => {
    expect(preflightStartAgent({ prompt: '   ', sessionId: 'ses_1' })).toEqual({
      ok: true,
      named: null,
    });
  });

  it('refuses a request that names neither a prompt nor a session', () => {
    expect(preflightStartAgent({ prompt: '  ' })).toEqual({
      ok: false,
      result: {
        ok: false,
        action: 'StartAgent',
        code: 'empty-prompt',
        retryable: false,
        message: i18n.t('appActions.start.promptRequired'),
      },
    });
  });

  it('resolves a named repository into the platform and project path', () => {
    expect(
      preflightStartAgent({
        prompt: 'fix the build',
        repository: 'https://gitlab.com/group/sub/project',
      })
    ).toEqual({ ok: true, named: { kind: 'gitlab', fullName: 'group/sub/project' } });
  });

  it('refuses a named repository whose host is not a known provider', () => {
    expect(
      preflightStartAgent({ prompt: 'fix the build', repository: 'https://git.example.com/o/r' })
    ).toEqual({
      ok: false,
      result: {
        ok: false,
        action: 'StartAgent',
        code: 'unknown-repository',
        retryable: false,
        message: i18n.t('appActions.start.repositoryUnknown', {
          repository: 'https://git.example.com/o/r',
        }),
      },
    });
  });

  it('refuses a repository the create call cannot address from an action', () => {
    expect(
      preflightStartAgent({
        prompt: 'fix the build',
        repository: 'https://bitbucket.org/workspace/project',
      })
    ).toEqual({
      ok: false,
      result: {
        ok: false,
        action: 'StartAgent',
        code: 'unsupported-repository',
        retryable: false,
        message: i18n.t('appActions.start.repositoryUnsupported', {
          repository: 'workspace/project',
        }),
      },
    });
  });
});
