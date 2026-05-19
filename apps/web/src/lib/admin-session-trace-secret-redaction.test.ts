import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isRedactedSecretToken,
  redactHighConfidenceSecrets,
} from '@/scripts/session-traces/admin-session-trace-secret-redaction';
import { redactExportDirectorySecrets } from '@/scripts/session-traces/redact-exported-admin-session-trace-secrets';

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-session-secret-redaction-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('admin session trace high-confidence secret redaction', () => {
  it('redacts secret-shaped strings while keeping PEM private key markers', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'sensitive-body',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const result = redactHighConfidenceSecrets(
      {
        text: `GitHub ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890, Hugging Face hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890, and JWT eyJaaaaaaaaaa.bbbbbbbbbb.cccccccccc`,
        key: pem,
      },
      'fixture-key'
    );
    const value = result.value as { text: string; key: string };

    expect(result.changed).toBe(true);
    expect(value.text).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
    expect(value.text).not.toContain('hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
    expect(value.text).not.toContain('eyJaaaaaaaaaa.bbbbbbbbbb.cccccccccc');
    expect(value.text).toContain('[REDACTED_SECRET:v1:github-token:');
    expect(value.text).toContain('[REDACTED_SECRET:v1:huggingface-token:');
    expect(value.text).toContain('[REDACTED_SECRET:v1:jwt-like-token:');
    expect(value.key).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(value.key).toContain('-----END OPENSSH PRIVATE KEY-----');
    expect(value.key).not.toContain('sensitive-body');
    expect(value.key).toContain('[REDACTED_SECRET:v1:pem-openssh-private-key:');
    expect(result.stats.totalReplacements).toBe(4);
  });

  it('redacts provider-anchored bearer credentials and skips unanchored or placeholder bearers', () => {
    const result = redactHighConfidenceSecrets(
      {
        meta: [
          'URL: https://graph.facebook.com/v18.0/123/messages',
          'Authorization: Bearer MetaBearerTokenValue1234567890',
        ].join('\n'),
        supabase: [
          'POST https://project-ref.supabase.co/rest/v1/items',
          'Authorization: Bearer SupabaseBearerTokenValue1234567890',
        ].join('\n'),
        github: [
          'Authorization: Bearer GithubOpaqueBearerValue1234567890',
          'GET https://api.github.com/repos/acme/widgets',
        ].join('\n'),
        generic: 'Authorization: Bearer GenericOpaqueBearerValue1234567890',
        placeholder: [
          'GET https://api.github.com/repos/acme/widgets',
          'Authorization: Bearer YOUR_GITHUB_TOKEN_EXAMPLE',
        ].join('\n'),
      },
      'fixture-key'
    );
    const value = result.value as Record<string, string>;

    expect(value.meta).not.toContain('MetaBearerTokenValue1234567890');
    expect(value.supabase).not.toContain('SupabaseBearerTokenValue1234567890');
    expect(value.github).not.toContain('GithubOpaqueBearerValue1234567890');
    expect(value.meta).toContain('[REDACTED_SECRET:v1:meta-graph-bearer-token:');
    expect(value.supabase).toContain('[REDACTED_SECRET:v1:supabase-bearer-token:');
    expect(value.github).toContain('[REDACTED_SECRET:v1:github-api-bearer-token:');
    expect(value.generic).toContain('GenericOpaqueBearerValue1234567890');
    expect(value.placeholder).toContain('YOUR_GITHUB_TOKEN_EXAMPLE');
    expect(result.stats.replacementsByCategory).toEqual(
      expect.objectContaining({
        'meta-graph-bearer-token': 1,
        'supabase-bearer-token': 1,
        'github-api-bearer-token': 1,
      })
    );
  });

  it('is deterministic and idempotent', () => {
    const first = redactHighConfidenceSecrets(
      'sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      'fixture-key'
    );
    const second = redactHighConfidenceSecrets(first.value, 'fixture-key');

    expect(typeof first.value).toBe('string');
    expect(isRedactedSecretToken(first.value as string)).toBe(true);
    expect(second).toEqual({
      value: first.value,
      changed: false,
      stats: { replacementsByCategory: {}, totalReplacements: 0 },
    });
  });

  it('rewrites exported artifacts recursively without changing JSON structure', async () => {
    const root = await makeTempDir();
    const sessionDir = path.join(root, 'ses_fixture');
    await mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');
    const stripeFixture = ['sk', 'live', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('_');
    const googleFixture = ['AI', 'za', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789'].join('');
    const artifact = {
      export_format: 'admin-session-trace-bundle-v1',
      admin_session_trace: { title: `Stripe ${stripeFixture}` },
      admin_session_messages: {
        messages: [{ parts: [{ text: googleFixture }] }],
      },
    };
    await writeFile(sessionPath, JSON.stringify(artifact, null, 2) + '\n');

    const summary = await redactExportDirectorySecrets({
      inputDir: root,
      execute: true,
      concurrency: 1,
      pseudonymKey: 'fixture-key',
      pseudonymKeyEnv: 'FIXTURE_KEY',
    });
    const rewritten = await readFile(sessionPath, 'utf8');

    expect(summary).toEqual(
      expect.objectContaining({
        rewritten: 1,
        failed: 0,
        total_redactions: 2,
      })
    );
    expect(rewritten).not.toContain(stripeFixture);
    expect(rewritten).not.toContain(googleFixture);
    expect(rewritten).toContain('[REDACTED_SECRET:v1:stripe-live-secret:');
    expect(rewritten).toContain('[REDACTED_SECRET:v1:google-api-key:');
  });
});
