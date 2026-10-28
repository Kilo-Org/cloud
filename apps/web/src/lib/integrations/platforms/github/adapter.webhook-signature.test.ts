import crypto from 'crypto';

import { verifyGitHubWebhookSignature } from './adapter';

/**
 * The jest moduleNameMapper redirects `@/lib/integrations/platforms/github/adapter`
 * to an always-accepting stub, so this suite imports `./adapter` to exercise the
 * real verifier.
 */

const STANDARD_SECRET = 'standard-webhook-secret';
const LITE_SECRET = 'lite-webhook-secret';
const PAYLOAD = JSON.stringify({ action: 'opened', installation: { id: 42 } });

function signatureFor(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

const ORIGINAL_STANDARD = process.env.GITHUB_APP_WEBHOOK_SECRET;
const ORIGINAL_LITE = process.env.GITHUB_LITE_APP_WEBHOOK_SECRET;

function setSecrets(standard: string | undefined, lite: string | undefined): void {
  setEnv('GITHUB_APP_WEBHOOK_SECRET', standard);
  setEnv('GITHUB_LITE_APP_WEBHOOK_SECRET', lite);
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  setSecrets(ORIGINAL_STANDARD, ORIGINAL_LITE);
});

describe('verifyGitHubWebhookSignature', () => {
  it('accepts a delivery signed with the configured secret', () => {
    setSecrets(STANDARD_SECRET, LITE_SECRET);

    expect(
      verifyGitHubWebhookSignature(PAYLOAD, signatureFor(PAYLOAD, STANDARD_SECRET), 'standard')
    ).toBe('valid');
    expect(verifyGitHubWebhookSignature(PAYLOAD, signatureFor(PAYLOAD, LITE_SECRET), 'lite')).toBe(
      'valid'
    );
  });

  it('reports an unconfigured secret and never accepts a signature made with an empty key', () => {
    setSecrets(undefined, undefined);

    expect(verifyGitHubWebhookSignature(PAYLOAD, signatureFor(PAYLOAD, ''), 'standard')).toBe(
      'unconfigured'
    );
    expect(verifyGitHubWebhookSignature(PAYLOAD, signatureFor(PAYLOAD, ''), 'lite')).toBe(
      'unconfigured'
    );
  });

  it('treats an empty configured value as unconfigured', () => {
    setSecrets('', '');

    expect(verifyGitHubWebhookSignature(PAYLOAD, signatureFor(PAYLOAD, ''), 'lite')).toBe(
      'unconfigured'
    );
  });

  it('rejects a signature made with a different key', () => {
    setSecrets(STANDARD_SECRET, LITE_SECRET);

    expect(
      verifyGitHubWebhookSignature(PAYLOAD, signatureFor(PAYLOAD, 'other-secret'), 'standard')
    ).toBe('invalid');
  });

  it('does not accept the lite app signature for the standard app', () => {
    setSecrets(STANDARD_SECRET, LITE_SECRET);

    expect(
      verifyGitHubWebhookSignature(PAYLOAD, signatureFor(PAYLOAD, LITE_SECRET), 'standard')
    ).toBe('invalid');
  });

  it('rejects a delivery whose body changed after signing', () => {
    setSecrets(STANDARD_SECRET, LITE_SECRET);
    const signature = signatureFor(PAYLOAD, STANDARD_SECRET);

    expect(verifyGitHubWebhookSignature(`${PAYLOAD} `, signature, 'standard')).toBe('invalid');
  });

  it('rejects a missing or malformed signature header', () => {
    setSecrets(STANDARD_SECRET, LITE_SECRET);

    expect(verifyGitHubWebhookSignature(PAYLOAD, '', 'standard')).toBe('invalid');
    expect(verifyGitHubWebhookSignature(PAYLOAD, 'sha256=not-hex', 'standard')).toBe('invalid');
    expect(verifyGitHubWebhookSignature(PAYLOAD, 'sha1=abc', 'standard')).toBe('invalid');
  });
});
