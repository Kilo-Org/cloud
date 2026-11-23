import { describe, expect, it } from 'vitest';
import {
  networkSecretHostSchema,
  networkSecretPolicySchema,
  networkSecretsSchema,
  assertNetworkSecretDestinations,
} from './network-secrets';

const excludedUrls = ['https://gitlab.example.com/team/repo.git'];

function snapshotFor(allowedHosts: string[]) {
  return networkSecretsSchema.parse({
    KEY: {
      allowedHosts,
      envelope: {
        algorithm: 'rsa-aes-256-gcm',
        version: 1,
        encryptedData: 'synthetic',
        encryptedDEK: 'synthetic',
      },
    },
  });
}

describe('network secret destinations', () => {
  it.each(['sentry.io', 'api.axiom.co', 'npm.pkg.github.com'])('accepts %s', host => {
    expect(networkSecretHostSchema.parse(host)).toBe(host);
  });
  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '[::1]',
    'localhost',
    'service.localhost',
    'service.internal',
    '*.example.com',
    'https://example.com',
    'example.com:443',
    'github.com',
    'api.github.com',
    'uploads.github.com',
    'bitbucket.org',
    'gitlab.com',
    'api.kilo.ai',
    'ingest.kilosessions.ai',
    'metadata.google.internal',
  ])('rejects %s', host => {
    expect(networkSecretHostSchema.safeParse(host).success).toBe(false);
  });
  it('normalizes and bounds exact destinations and header-only placement', () => {
    expect(
      networkSecretPolicySchema.parse({ allowedHosts: ['API.EXAMPLE.COM.', 'api.example.com'] })
    ).toEqual({ allowedHosts: ['api.example.com'], locations: ['header'] });
    expect(networkSecretPolicySchema.safeParse({ allowedHosts: [] }).success).toBe(false);
    expect(
      networkSecretPolicySchema.safeParse({
        allowedHosts: ['api.example.com'],
        locations: ['query'],
      }).success
    ).toBe(false);
  });
  it('rejects configured platform or SCM destinations', () => {
    expect(() =>
      assertNetworkSecretDestinations(snapshotFor(['gitlab.example.com']), excludedUrls)
    ).toThrow('cannot target');
  });
  it.each([['GITLAB.Example.COM'], ['gitlab.example.com.']])(
    'rejects managed SCM destinations after host normalization (%#)',
    host => {
      expect(() => assertNetworkSecretDestinations(snapshotFor([host]), excludedUrls)).toThrow(
        'cannot target'
      );
    }
  );
  it('accepts public destinations', () => {
    expect(() =>
      assertNetworkSecretDestinations(snapshotFor(['api.example.com']), excludedUrls)
    ).not.toThrow();
  });
});
