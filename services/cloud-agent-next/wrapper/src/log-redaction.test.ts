import { expect, it } from 'bun:test';
import { redactLogText, rememberLogSecrets } from './log-redaction.js';

it('retains useful diagnostics across repeated credential refreshes with large configurations', () => {
  const config = JSON.stringify({
    provider: { apiKey: 'fixture-provider-credential-123' },
    instructions: 'configuration text '.repeat(5_000),
  });
  const environment = {
    KILO_CONFIG_CONTENT: config,
    OPENCODE_CONFIG_CONTENT: config,
    BUILD_DESCRIPTION: 'public build metadata '.repeat(60_000),
    PROFILE_VALUE: 'fixture-profile-credential-456',
  };
  for (let refresh = 0; refresh < 150; refresh++) {
    rememberLogSecrets(environment, ['PROFILE_VALUE']);
  }
  rememberLogSecrets({ API_TOKEN: 'fixture-refreshed-credential-789' });

  expect(redactLogText('useful diagnostic')).toBe('useful diagnostic');
  for (const value of [
    config,
    'fixture-provider-credential-123',
    environment.PROFILE_VALUE,
    'fixture-refreshed-credential-789',
  ]) {
    expect(redactLogText(`useful diagnostic: ${value}`)).toBe('useful diagnostic: [REDACTED]');
  }
});
