import { authenticationResponseSchema, registrationResponseSchema } from './passkey-response';

const credential = {
  id: 'credential',
  rawId: 'credential',
  type: 'public-key',
  clientExtensionResults: {},
};

const attestation = {
  ...credential,
  response: { clientDataJSON: 'client-data', attestationObject: 'attestation' },
};

const assertion = {
  ...credential,
  response: {
    clientDataJSON: 'client-data',
    authenticatorData: 'authenticator-data',
    signature: 'signature',
  },
};

describe('native passkey response boundaries', () => {
  it('normalizes null optional registration fields from the native bridge', () => {
    const parsed = registrationResponseSchema.parse({
      ...attestation,
      authenticatorAttachment: null,
      clientExtensionResults: null,
      response: {
        ...attestation.response,
        authenticatorData: null,
        transports: null,
        publicKeyAlgorithm: null,
        publicKey: null,
      },
    });

    expect(parsed).toEqual({
      ...attestation,
      authenticatorAttachment: undefined,
      response: {
        ...attestation.response,
        authenticatorData: undefined,
        transports: undefined,
        publicKeyAlgorithm: undefined,
        publicKey: undefined,
      },
    });
  });

  it('normalizes null optional assertion fields from the native bridge', () => {
    const parsed = authenticationResponseSchema.parse({
      ...assertion,
      authenticatorAttachment: null,
      clientExtensionResults: null,
      response: { ...assertion.response, userHandle: null },
    });

    expect(parsed).toEqual({
      ...assertion,
      authenticatorAttachment: undefined,
      response: { ...assertion.response, userHandle: undefined },
    });
  });

  it.each(['clientDataJSON', 'attestationObject'])('rejects null registration %s', field => {
    expect(
      registrationResponseSchema.safeParse({
        ...attestation,
        response: { ...attestation.response, [field]: null },
      }).success
    ).toBe(false);
  });

  it.each(['clientDataJSON', 'authenticatorData', 'signature'])('rejects null assertion %s', field => {
    expect(
      authenticationResponseSchema.safeParse({
        ...assertion,
        response: { ...assertion.response, [field]: null },
      }).success
    ).toBe(false);
  });
});
