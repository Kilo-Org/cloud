import { createHmac } from 'node:crypto';
import {
  deriveBitbucketWebhookSecret,
  parseBitbucketWebhookSigningKeyring,
  verifyBitbucketWebhookSignature,
} from './webhook-signing';

const ACTIVE_KEY_BYTES = Buffer.alloc(32, 1);
const PREVIOUS_KEY_BYTES = Buffer.alloc(32, 2);
const ACTIVE_KEY = ACTIVE_KEY_BYTES.toString('base64');
const PREVIOUS_KEY = PREVIOUS_KEY_BYTES.toString('base64');
const identity = {
  integrationId: '9bfedc45-c46d-47bb-aeab-bfb88ae33fdd',
  workspaceUuid: '4f67721a-9c5a-4a1e-a431-fdac4a744fac',
};

function keyringJson() {
  return JSON.stringify({ active: ACTIVE_KEY, previous: PREVIOUS_KEY });
}

function signature(rawBody: Uint8Array, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

describe('Bitbucket webhook signing', () => {
  it('derives a versioned integration-and-workspace secret from the active key only', () => {
    const keyring = parseBitbucketWebhookSigningKeyring(keyringJson());
    const activeSecret = deriveBitbucketWebhookSecret(keyring.active, identity);

    expect(keyring.active).toEqual(ACTIVE_KEY_BYTES);
    expect(keyring.previous).toEqual(PREVIOUS_KEY_BYTES);
    expect(activeSecret).toBe(deriveBitbucketWebhookSecret(keyring.active, identity));
    expect(activeSecret).not.toBe(
      deriveBitbucketWebhookSecret(keyring.previous ?? keyring.active, identity)
    );
    expect(activeSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(
      deriveBitbucketWebhookSecret(keyring.active, {
        ...identity,
        integrationId: 'c2783f9e-4369-4e8d-8c0b-6a12bc4e1d27',
      })
    ).not.toBe(activeSecret);
    expect(
      deriveBitbucketWebhookSecret(keyring.active, {
        ...identity,
        workspaceUuid: '00000000-0000-4000-8000-000000000001',
      })
    ).not.toBe(activeSecret);
  });

  it('accepts active and previous signatures over the exact raw bytes', () => {
    const keyring = parseBitbucketWebhookSigningKeyring(keyringJson());
    const rawBody = new TextEncoder().encode('{"message":"Hello World!"}\n');
    const activeSecret = deriveBitbucketWebhookSecret(keyring.active, identity);
    const previousKey = keyring.previous;
    if (!previousKey) throw new Error('Expected previous signing key');
    const previousSecret = deriveBitbucketWebhookSecret(previousKey, identity);

    expect(
      verifyBitbucketWebhookSignature(rawBody, signature(rawBody, activeSecret), keyring, identity)
    ).toBe(true);
    expect(
      verifyBitbucketWebhookSignature(
        rawBody,
        signature(rawBody, previousSecret),
        keyring,
        identity
      )
    ).toBe(true);
    expect(
      verifyBitbucketWebhookSignature(
        new TextEncoder().encode('{"message":"Hello World!"}'),
        signature(rawBody, activeSecret),
        keyring,
        identity
      )
    ).toBe(false);
  });

  it.each([
    'sha1=a4771c39fbe90f317c7824e83ddef3caae9cb3d9',
    'sha256=A4771C39FBE90F317C7824E83DDEF3CAAE9CB3D976C214ACE1F2937E133263C9',
    'sha256=not-hex',
    `sha256=${'0'.repeat(64)}`,
  ])('rejects invalid or incorrect signature %s', signatureHeader => {
    expect(
      verifyBitbucketWebhookSignature(
        new TextEncoder().encode('Hello World!'),
        signatureHeader,
        parseBitbucketWebhookSigningKeyring(keyringJson()),
        identity
      )
    ).toBe(false);
  });

  it('accepts independently sized active and previous keys within the key bounds', () => {
    const keyring = parseBitbucketWebhookSigningKeyring(
      JSON.stringify({ active: ACTIVE_KEY, previous: Buffer.alloc(64, 3).toString('base64') })
    );

    expect(keyring.active).toHaveLength(32);
    expect(keyring.previous).toHaveLength(64);
  });

  it.each([
    undefined,
    '',
    'not-json',
    '{}',
    JSON.stringify({ active: 'not-base64' }),
    JSON.stringify({ active: Buffer.alloc(31).toString('base64') }),
    JSON.stringify({ active: ACTIVE_KEY, previous: ACTIVE_KEY }),
    JSON.stringify({ active: ACTIVE_KEY, extra: true }),
  ])('rejects malformed keyring input %#', value => {
    expect(() => parseBitbucketWebhookSigningKeyring(value)).toThrow(
      'Invalid Bitbucket webhook signing keyring'
    );
  });

  it.each([
    { ...identity, integrationId: identity.integrationId.toUpperCase() },
    { ...identity, workspaceUuid: `{${identity.workspaceUuid}}` },
  ])('requires canonical signing identity %#', invalidIdentity => {
    expect(() =>
      deriveBitbucketWebhookSecret(
        parseBitbucketWebhookSigningKeyring(keyringJson()).active,
        invalidIdentity
      )
    ).toThrow();
  });
});
