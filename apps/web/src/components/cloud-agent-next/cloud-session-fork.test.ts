import {
  deriveCloudSessionForkFields,
  parseGitLabProjectPath,
  cloudForkRejectionMessage,
  continueInNewCloudSession,
  runCloudForkFlow,
  buildCloudChatSessionPath,
  type CloudRuntimeConfig,
  type CloudForkRejectionReason,
  type CloudSessionForkRuntimeStateResult,
} from './cloud-session-fork';

const CLOUD_SESSION = {
  session_id: 'ses_1234567890abcdef',
  cloud_agent_session_id: 'agent_12345678-1234-4234-9234-123456789abc',
  organization_id: null,
};
const CLI_SESSION = {
  session_id: 'ses_1234567890abcdef',
  cloud_agent_session_id: null,
  organization_id: null,
};

function runtime(overrides: Partial<CloudRuntimeConfig> = {}): CloudRuntimeConfig {
  return {
    platform: 'github',
    githubRepo: 'kilocode/kilo',
    mode: 'code',
    model: 'kilocode/claude-sonnet-4',
    ...overrides,
  };
}

const githubRuntime = runtime({ autoCommit: true });

describe('deriveCloudSessionForkFields', () => {
  it('rejects sessions that are not Cloud Agent sessions', () => {
    const result = deriveCloudSessionForkFields({ session: CLI_SESSION, runtime: runtime() });

    expect(result).toEqual({ ok: false, reason: 'not-a-cloud-session' });
  });

  it('rejects cloud sessions whose runtime configuration is unavailable', () => {
    const result = deriveCloudSessionForkFields({ session: CLOUD_SESSION, runtime: null });

    expect(result).toEqual({ ok: false, reason: 'runtime-unavailable' });
  });

  it('derives a GitHub fork when the runtime exposes a GitHub repository', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({ autoCommit: true }),
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        mode: 'code',
        model: 'kilocode/claude-sonnet-4',
        variant: undefined,
        autoCommit: true,
        repository: { kind: 'github', fullName: 'kilocode/kilo' },
      },
    });
  });

  it('derives a GitHub fork from the runtime git URL when githubRepo is absent', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({
        githubRepo: undefined,
        gitUrl: 'https://github.com/kilocode/kilo.git',
      }),
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        mode: 'code',
        model: 'kilocode/claude-sonnet-4',
        variant: undefined,
        autoCommit: false,
        repository: { kind: 'github', fullName: 'kilocode/kilo' },
      },
    });
  });

  it('infers a GitHub platform from a GitHub git URL when platform is missing', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({
        platform: undefined,
        githubRepo: undefined,
        gitUrl: 'https://github.com/kilocode/kilo.git',
      }),
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        mode: 'code',
        model: 'kilocode/claude-sonnet-4',
        variant: undefined,
        autoCommit: false,
        repository: { kind: 'github', fullName: 'kilocode/kilo' },
      },
    });
  });

  it('drops a malformed runtime variant instead of failing the fork', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({ variant: 'thinking-v2' }),
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        mode: 'code',
        model: 'kilocode/claude-sonnet-4',
        variant: undefined,
        autoCommit: false,
        repository: { kind: 'github', fullName: 'kilocode/kilo' },
      },
    });
  });

  it('forwards runtime agents so custom agent modes remain forkable', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({
        mode: 'security-review',
        runtimeAgents: [
          {
            slug: 'security-review',
            name: 'Security Review',
            model: 'a-model',
            variant: 'thinking',
          },
          { slug: 'plain-agent', name: 'Plain Agent' },
        ],
      }),
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        mode: 'security-review',
        model: 'kilocode/claude-sonnet-4',
        variant: undefined,
        autoCommit: false,
        runtimeAgents: [
          {
            slug: 'security-review',
            name: 'Security Review',
            config: { model: 'a-model', variant: 'thinking' },
          },
          { slug: 'plain-agent', name: 'Plain Agent', config: {} },
        ],
        repository: { kind: 'github', fullName: 'kilocode/kilo' },
      },
    });
  });

  it('carries the runtime variant and default autoCommit to false when unset', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({ variant: 'thinking' }),
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        mode: 'code',
        model: 'kilocode/claude-sonnet-4',
        variant: 'thinking',
        autoCommit: false,
        repository: { kind: 'github', fullName: 'kilocode/kilo' },
      },
    });
  });

  it('rejects when the runtime has no model', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({ model: undefined }),
    });

    expect(result).toEqual({ ok: false, reason: 'missing-model' });
  });

  it('rejects when the runtime has no mode', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({ mode: undefined }),
    });

    expect(result).toEqual({ ok: false, reason: 'missing-mode' });
  });

  it('rejects when the runtime mode is not a valid mode slug', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({ mode: 'Code Agent' }),
    });

    expect(result).toEqual({ ok: false, reason: 'invalid-mode' });
  });

  it('rejects a GitHub session whose runtime has no repository', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({ githubRepo: undefined }),
    });

    expect(result).toEqual({ ok: false, reason: 'missing-repository' });
  });

  it('derives a GitLab fork from the runtime git URL', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({
        platform: 'gitlab',
        githubRepo: undefined,
        gitUrl: 'https://gitlab.com/acme/widgets.git',
      }),
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        mode: 'code',
        model: 'kilocode/claude-sonnet-4',
        variant: undefined,
        autoCommit: false,
        repository: { kind: 'gitlab', projectPath: 'acme/widgets' },
      },
    });
  });

  it('rejects a GitLab session whose git URL cannot be parsed into a project path', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({
        platform: 'gitlab',
        githubRepo: undefined,
        gitUrl: 'https://gitlab.com/not-a-nested-project',
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'unparseable-repository' });
  });

  it('rejects a GitLab session with no git URL', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({ platform: 'gitlab', githubRepo: undefined, gitUrl: undefined }),
    });

    expect(result).toEqual({ ok: false, reason: 'missing-repository' });
  });

  it('rejects Bitbucket sessions as unsupported for cloud-to-cloud forks', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({
        platform: 'bitbucket',
        githubRepo: undefined,
        gitUrl: 'https://bitbucket.org/acme/widgets.git',
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'unsupported-platform' });
  });

  it('rejects an unrecognized platform', () => {
    const result = deriveCloudSessionForkFields({
      session: CLOUD_SESSION,
      runtime: runtime({
        platform: 'gitea',
        githubRepo: undefined,
        gitUrl: 'https://gitea.example/a/b.git',
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'unsupported-platform' });
  });
});

describe('parseGitLabProjectPath', () => {
  it.each([
    ['https://gitlab.com/group/project.git', 'group/project'],
    ['https://gitlab.com/group/project', 'group/project'],
    ['https://gitlab.com/group/project/', 'group/project'],
    ['https://gitlab.example.com/group/subgroup/project.git', 'group/subgroup/project'],
    ['ssh://git@gitlab.com/group/project.git', 'group/project'],
    ['git@gitlab.com:group/project.git', 'group/project'],
  ])('parses %s into %s', (url, expected) => {
    expect(parseGitLabProjectPath(url)).toBe(expected);
  });

  it.each([
    ['https://gitlab.com/project.git', 'project name has no namespace'],
    ['not a url', 'not a URL'],
    ['https://gitlab.com/', 'empty path'],
    ['', 'empty input'],
  ])('returns null for %s (%s)', url => {
    expect(parseGitLabProjectPath(url)).toBeNull();
  });
});

describe('cloudForkRejectionMessage', () => {
  const expected: Record<CloudForkRejectionReason, string> = {
    'not-a-cloud-session': 'Only Cloud Agent sessions can be forked to a new Cloud Agent session.',
    'runtime-unavailable': 'This session has no saved Cloud Agent configuration to copy.',
    'missing-model': 'This session has no model selected to copy.',
    'missing-mode': 'This session has no agent mode selected to copy.',
    'invalid-mode': "This session's agent mode cannot be reused.",
    'missing-repository': 'This session has no repository to copy.',
    'unsupported-platform':
      "Forking this session's repository to a new Cloud Agent session is not supported yet.",
    'unparseable-repository': "This session's repository cannot be reused.",
    'organization-mismatch': 'You can only fork this session inside its own organization.',
  };

  it('maps every rejection reason to a user-facing message', () => {
    for (const reason of Object.keys(expected) as CloudForkRejectionReason[]) {
      expect(cloudForkRejectionMessage(reason)).toBe(expected[reason]);
    }
  });
});

describe('continueInNewCloudSession', () => {
  const createDeps = (
    overrides: {
      session?: CloudSessionForkRuntimeStateResult['session'];
      runtimeState?: CloudRuntimeConfig | null;
    } = {}
  ) => {
    const getRuntimeState = jest.fn().mockResolvedValue({
      session: overrides.session ?? {
        session_id: CLOUD_SESSION.session_id,
        cloud_agent_session_id: CLOUD_SESSION.cloud_agent_session_id,
        organization_id: null,
      },
      runtimeState: overrides.runtimeState === undefined ? githubRuntime : overrides.runtimeState,
    });
    const createSession = jest
      .fn()
      .mockResolvedValue({ kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaa' });
    return { getRuntimeState, createSession };
  };

  it('forks a personal GitHub cloud session through the caller-provided create mutation', async () => {
    const { getRuntimeState, createSession } = createDeps();

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: true, kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaa' });
    expect(getRuntimeState).toHaveBeenCalledWith(CLOUD_SESSION.session_id);
    expect(createSession).toHaveBeenCalledWith({
      mode: 'code',
      model: 'kilocode/claude-sonnet-4',
      variant: undefined,
      autoCommit: true,
      cloneFromKiloSessionId: CLOUD_SESSION.session_id,
      autoInitiate: true,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      githubRepo: 'kilocode/kilo',
    });
  });

  it('maps a GitLab repository to a gitlabProject field', async () => {
    const { getRuntimeState, createSession } = createDeps({
      runtimeState: runtime({
        platform: 'gitlab',
        githubRepo: undefined,
        gitUrl: 'https://gitlab.com/acme/widgets.git',
      }),
    });

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: true, kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaa' });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ gitlabProject: 'acme/widgets' })
    );
  });

  it('allows an org-scoped fork when the caller organization matches the session organization', async () => {
    const { getRuntimeState, createSession } = createDeps({
      session: {
        session_id: CLOUD_SESSION.session_id,
        cloud_agent_session_id: CLOUD_SESSION.cloud_agent_session_id,
        organization_id: '11111111-1111-4111-8111-111111111111',
      },
    });

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      organizationId: '11111111-1111-4111-8111-111111111111',
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: true, kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaa' });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: '11111111-1111-4111-8111-111111111111' })
    );
  });

  it('rejects forking an org session from a personal context', async () => {
    const { getRuntimeState, createSession } = createDeps({
      session: {
        session_id: CLOUD_SESSION.session_id,
        cloud_agent_session_id: CLOUD_SESSION.cloud_agent_session_id,
        organization_id: '11111111-1111-4111-8111-111111111111',
      },
    });

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: false, reason: 'organization-mismatch' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects forking an org session from a different organization context', async () => {
    const { getRuntimeState, createSession } = createDeps({
      session: {
        session_id: CLOUD_SESSION.session_id,
        cloud_agent_session_id: CLOUD_SESSION.cloud_agent_session_id,
        organization_id: '11111111-1111-4111-8111-111111111111',
      },
    });

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      organizationId: '22222222-2222-4222-8222-222222222222',
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: false, reason: 'organization-mismatch' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects a personal fork into an organization context', async () => {
    const { getRuntimeState, createSession } = createDeps();

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      organizationId: '11111111-1111-4111-8111-111111111111',
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: false, reason: 'organization-mismatch' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not call createSession when the source session cannot be derived', async () => {
    const { getRuntimeState, createSession } = createDeps({
      session: { ...CLOUD_SESSION, cloud_agent_session_id: null },
    });

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: false, reason: 'not-a-cloud-session' });
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe('buildCloudChatSessionPath', () => {
  it('builds a personal chat path from a session id', () => {
    expect(buildCloudChatSessionPath(undefined, 'ses_1234567890abcdef')).toBe(
      '/cloud/chat?sessionId=ses_1234567890abcdef'
    );
  });

  it('builds an organization chat path from a session id', () => {
    expect(
      buildCloudChatSessionPath('11111111-1111-4111-8111-111111111111', 'ses_1234567890abcdef')
    ).toBe(
      '/organizations/11111111-1111-4111-8111-111111111111/cloud/chat?sessionId=ses_1234567890abcdef'
    );
  });
});

describe('runCloudForkFlow', () => {
  const baseDeps = () => {
    const getRuntimeState = jest.fn().mockResolvedValue({
      session: {
        session_id: CLOUD_SESSION.session_id,
        cloud_agent_session_id: CLOUD_SESSION.cloud_agent_session_id,
        organization_id: null,
      },
      runtimeState: githubRuntime,
    });
    const createSession = jest
      .fn()
      .mockResolvedValue({ kiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbb' });
    const invalidateSessionQueries = jest.fn().mockResolvedValue(undefined);
    const navigateToSession = jest.fn();
    const notifyError = jest.fn();
    return {
      getRuntimeState,
      createSession,
      invalidateSessionQueries,
      navigateToSession,
      notifyError,
    };
  };

  it('navigates to the new session after a successful fork', async () => {
    const deps = baseDeps();

    const ok = await runCloudForkFlow({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps,
    });

    expect(ok).toBe(true);
    expect(deps.invalidateSessionQueries).toHaveBeenCalled();
    expect(deps.navigateToSession).toHaveBeenCalledWith('ses_bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(deps.notifyError).not.toHaveBeenCalled();
  });

  it('notifies the mapped reason and does not navigate on a rejection', async () => {
    const deps = baseDeps();
    deps.getRuntimeState.mockResolvedValue({
      session: { ...CLOUD_SESSION, cloud_agent_session_id: null },
      runtimeState: githubRuntime,
    });

    const ok = await runCloudForkFlow({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps,
    });

    expect(ok).toBe(false);
    expect(deps.notifyError).toHaveBeenCalledWith(
      'Only Cloud Agent sessions can be forked to a new Cloud Agent session.'
    );
    expect(deps.navigateToSession).not.toHaveBeenCalled();
  });

  it('still navigates when cache invalidation fails', async () => {
    const deps = baseDeps();
    deps.invalidateSessionQueries.mockRejectedValue(new Error('invalidate boom'));

    const ok = await runCloudForkFlow({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps,
    });

    expect(ok).toBe(true);
    expect(deps.navigateToSession).toHaveBeenCalledWith('ses_bbbbbbbbbbbbbbbbbbbbbbbb');
  });
});

describe('continueInNewCloudSession configuration forwarding', () => {
  const depsFor = (runtimeState: CloudRuntimeConfig) => {
    const getRuntimeState = jest.fn().mockResolvedValue({
      session: CLOUD_SESSION,
      runtimeState,
    });
    const createSession = jest
      .fn()
      .mockResolvedValue({ kiloSessionId: 'ses_cccccccccccccccccccccccc' });
    return { getRuntimeState, createSession };
  };

  it('forwards runtime agents so a custom agent mode stays forkable', async () => {
    const { getRuntimeState, createSession } = depsFor(
      runtime({
        mode: 'security-review',
        runtimeAgents: [
          {
            slug: 'security-review',
            name: 'Security Review',
            model: 'a-model',
            variant: 'thinking',
          },
        ],
      })
    );

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: true, kiloSessionId: 'ses_cccccccccccccccccccccccc' });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'security-review',
        runtimeAgents: [
          {
            slug: 'security-review',
            name: 'Security Review',
            config: { model: 'a-model', variant: 'thinking' },
          },
        ],
      })
    );
  });

  it('omits a malformed runtime variant from the create request', async () => {
    const { getRuntimeState, createSession } = depsFor(runtime({ variant: 'thinking-v2' }));

    const result = await continueInNewCloudSession({
      sessionId: CLOUD_SESSION.session_id,
      operationKey: '6b2c3e10-0000-4000-8000-000000000000',
      deps: { getRuntimeState, createSession },
    });

    expect(result).toEqual({ ok: true, kiloSessionId: 'ses_cccccccccccccccccccccccc' });
    expect(createSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'thinking-v2' })
    );
  });
});
