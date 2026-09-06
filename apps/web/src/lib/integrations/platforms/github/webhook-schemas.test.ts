import {
  InstallationDeletedPayloadSchema,
  InstallationDeletedWebhookPayloadSchema,
} from './webhook-schemas';

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
