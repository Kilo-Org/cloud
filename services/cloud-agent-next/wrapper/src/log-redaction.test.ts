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
    'fixture-provider-credential-123',
    environment.PROFILE_VALUE,
    'fixture-refreshed-credential-789',
  ]) {
    expect(redactLogText(`useful diagnostic: ${value}`)).toBe('useful diagnostic: [REDACTED]');
  }
  const safeConfig = redactLogText(config);
  expect(safeConfig).not.toContain('fixture-provider-credential-123');
  expect(safeConfig).toContain('configuration text');
});

it('retains historical credentials when large configurations rotate their provider and MCP tokens', () => {
  const secrets: string[] = [];
  for (let refresh = 0; refresh < 150; refresh++) {
    const apiKey = `rotating-provider-credential-${refresh}`;
    const mcpToken = `rotating-mcp-credential-${refresh}`;
    secrets.push(apiKey, mcpToken);
    const config = JSON.stringify({
      provider: { apiKey },
      mcp: { service: { headers: { 'X-Service-Auth': mcpToken } } },
      instructions: 'configuration text '.repeat(5_000),
    });
    rememberLogSecrets({ KILO_CONFIG_CONTENT: config, OPENCODE_CONFIG_CONTENT: config });
  }

  expect(redactLogText('useful diagnostic after rotation')).toBe(
    'useful diagnostic after rotation'
  );
  for (const secret of secrets) {
    expect(redactLogText(`retained credential: ${secret}`)).toBe('retained credential: [REDACTED]');
    expect(redactLogText(Buffer.from(secret).toString('base64'))).toBe('[REDACTED]');
  }
});

it('masks serialized configuration environments without retaining whole configuration values', () => {
  const secret = 'fixture-quoted"credential\\value';
  const config = JSON.stringify({ kilo: { key: secret } });
  rememberLogSecrets({ KILO_AUTH_CONTENT: config });
  expect(redactLogText(JSON.stringify({ KILO_AUTH_CONTENT: config }))).toBe(
    JSON.stringify({ KILO_AUTH_CONTENT: '[REDACTED]' })
  );
  expect(redactLogText(`credential: ${secret}`)).toBe('credential: [REDACTED]');
});
