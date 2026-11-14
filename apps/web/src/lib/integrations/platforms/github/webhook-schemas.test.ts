import {
  InstallationDeletedPayloadSchema,
  InstallationDeletedWebhookPayloadSchema,
  PullRequestPayloadSchema,
} from './webhook-schemas';

describe('pull request mergeability payload', () => {
  it.each([true, false, null])('retains GitHub mergeable=%s without guessing', mergeable => {
    const parsed = PullRequestPayloadSchema.shape.pull_request.parse({
      number: 7,
      title: 'Status fields',
      state: 'open',
      mergeable,
      mergeable_state: mergeable === false ? 'dirty' : 'unknown',
      user: { id: 1, login: 'user', avatar_url: 'https://example.com/avatar' },
      head: { sha: 'a'.repeat(40), ref: 'feature' },
      base: { sha: 'b'.repeat(40), ref: 'main' },
    });
    expect(parsed.mergeable).toBe(mergeable);
    expect(parsed.mergeable_state).toBe(mergeable === false ? 'dirty' : 'unknown');
  });
});

function pullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    installation: { id: 1 },
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    },
    pull_request: {
      number: 42,
      title: 'Stacked',
      state: 'open',
      html_url: 'https://github.com/acme/widgets/pull/42',
      user: { id: 1, login: 'alice', avatar_url: 'https://example.com/a.png' },
      head: {
        sha: 'head-sha',
        ref: 'feature/b',
        repo: {
          full_name: 'acme/widgets',
          clone_url: 'https://github.com/acme/widgets.git',
          html_url: 'https://github.com/acme/widgets',
        },
      },
      base: { sha: 'base-sha', ref: 'feature/a' },
    },
    ...overrides,
  };
}

describe('PullRequestPayloadSchema stack metadata', () => {
  it.each([
    { number: null, position: null, size: null },
    { number: undefined, position: undefined, size: undefined },
    { number: 4 },
    {},
    null,
  ])('accepts a nullable/optional stack %j without rejecting the delivery', stack => {
    const payload = pullRequestPayload();
    const pullRequest = payload.pull_request as Record<string, unknown>;
    expect(
      PullRequestPayloadSchema.safeParse({
        ...payload,
        pull_request: { ...pullRequest, stack },
      }).success
    ).toBe(true);
  });

  it('accepts the top-level stack of the stacked action', () => {
    const payload = pullRequestPayload({
      action: 'stacked',
      stack: { number: 7, position: 2, size: 3 },
    });
    const parsed = PullRequestPayloadSchema.parse(payload);
    expect(parsed.stack).toEqual({ number: 7, position: 2, size: 3 });
  });

  it('reads the edited base ref', () => {
    const payload = pullRequestPayload({
      action: 'edited',
      changes: { base: { ref: { from: 'main' } } },
    });
    const parsed = PullRequestPayloadSchema.parse(payload);
    expect(parsed.pull_request.base.ref).toBe('feature/a');
  });
});

describe('InstallationDeletedWebhookPayloadSchema', () => {
  it.each([null, { id: 98765 }])('accepts installation %j', installation => {
    const payload = { action: 'deleted', installation };

    expect(InstallationDeletedWebhookPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each([undefined, {}, { id: '98765' }, { id: null }, '98765', []])(
    'rejects malformed installation %j',
    installation => {
      expect(
        InstallationDeletedWebhookPayloadSchema.safeParse({ action: 'deleted', installation })
          .success
      ).toBe(false);
    }
  );

  it('rejects other installation actions', () => {
    expect(
      InstallationDeletedWebhookPayloadSchema.safeParse({ action: 'created', installation: null })
        .success
    ).toBe(false);
  });

  it('keeps the cleanup handler payload non-nullable', () => {
    expect(
      InstallationDeletedPayloadSchema.safeParse({ action: 'deleted', installation: null }).success
    ).toBe(false);
    expect(
      InstallationDeletedPayloadSchema.parse({ action: 'deleted', installation: { id: 98765 } })
    ).toEqual({ action: 'deleted', installation: { id: 98765 } });
  });
});
