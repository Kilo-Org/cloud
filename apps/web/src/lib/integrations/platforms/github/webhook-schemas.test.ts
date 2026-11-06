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
