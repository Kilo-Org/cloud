import { describe, expect, test } from '@jest/globals';
import {
  byokPrivateProviderRouteSecrets,
  redactByokPrivateProviderSecrets,
} from '@kilocode/web-shared/lib/ai-gateway/byok-private-provider/redaction';

describe('byokPrivateProviderRouteSecrets', () => {
  test('lists the stored credential secrets and the resolved upstream key', () => {
    const secrets = byokPrivateProviderRouteSecrets({
      provider: { apiKey: 'ya29.access-token' },
      userByok: [
        {
          providerId: 'private-a1b2c3d4e5',
          decryptedAPIKey: JSON.stringify({
            type: 'aws_bedrock',
            region: 'eu-west-1',
            access_key_id: 'AKIDEXAMPLE',
            secret_access_key: 'aws-secret',
          }),
        },
      ],
    });

    expect(secrets).toEqual(['AKIDEXAMPLE', 'aws-secret', 'ya29.access-token']);
  });

  test('is null for a route to any other key', () => {
    expect(
      byokPrivateProviderRouteSecrets({
        provider: { apiKey: 'sk-synthetic' },
        userByok: [{ providerId: 'synthetic', decryptedAPIKey: 'sk-synthetic' }],
      })
    ).toBeNull();
    expect(
      byokPrivateProviderRouteSecrets({ provider: { apiKey: '' }, userByok: null })
    ).toBeNull();
  });
});

describe('redactByokPrivateProviderSecrets', () => {
  test('removes a secret and the masked ends an upstream shows of it', () => {
    const secret = 'sk-abcdefghijklmnop';

    expect(
      redactByokPrivateProviderSecrets(
        `bad key ${secret}, shown as ${secret.slice(0, 9)}...${secret.slice(-4)}`,
        [secret]
      )
    ).toBe('bad key [redacted], shown as [redacted]...[redacted]');
  });

  test('does not match regular expression characters in a secret', () => {
    expect(redactByokPrivateProviderSecrets('key a+b.c*d(e) end', ['a+b.c*d(e)'])).toBe(
      'key [redacted] end'
    );
  });

  test('redacts the full secret even when it is too long for partial matching', () => {
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(1700)}\n-----END PRIVATE KEY-----`;

    expect(redactByokPrivateProviderSecrets(`x ${privateKey}`, [privateKey])).toBe('x [redacted]');
  });

  test('ignores empty secrets', () => {
    expect(redactByokPrivateProviderSecrets('text', [''])).toBe('text');
  });
});
