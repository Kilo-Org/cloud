import { describe, expect, it } from 'vitest';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../shared/runtime-environment.js';
import { envVarsSchema } from '../types.js';
import { buildSessionAttachPayload } from './attach-payload.js';

describe('buildSessionAttachPayload', () => {
  it('packs directory, git clone, branch, snapshot identity, and session env', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userId: 'user-1',
        orgId: 'org-1',
      },
      auth: { kiloSessionId: 'kilo_1', kilocodeToken: 'cap_1' },
      agent: { mode: 'code', model: 'kilo/test' },
      repository: { type: 'github', repo: 'acme/demo', token: 'gh_token', upstreamBranch: 'main' },
      workspace: {},
      lifecycle: { version: 1, timestamp: 1 },
    });
    expect(buildSessionAttachPayload(metadata)).toEqual({
      snapshotIdentity: 'kilo_1',
      directory: expect.stringContaining('workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      branch: 'main',
      git: {
        url: 'https://github.com/acme/demo.git',
        platform: 'github',
        token: 'gh_token',
      },
      env: { KILOCODE_TOKEN: 'cap_1' },
    });
  });

  it('packs setup commands, injected auth env, and preparation identity', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userId: 'user-1',
      },
      auth: { kiloSessionId: 'kilo_1', kilocodeToken: 'cap_1' },
      agent: { mode: 'code', model: 'kilo/test' },
      profile: { envVars: {}, encryptedSecrets: {}, setupCommands: ['pnpm install'] },
      workspace: { workspacePath: '/workspace/a' },
      lifecycle: { version: 1, timestamp: 1 },
    });
    expect(
      buildSessionAttachPayload(metadata, { attemptId: 'att_1', triggerMessageId: 'msg_1' })
    ).toEqual({
      snapshotIdentity: 'kilo_1',
      directory: '/workspace/a',
      env: { KILOCODE_TOKEN: 'cap_1' },
      setupCommands: ['pnpm install'],
      preparation: { attemptId: 'att_1', triggerMessageId: 'msg_1' },
    });
  });

  for (const key of CONTROL_RUNTIME_RESERVED_ENV_VARS) {
    it(`rejects ${key} in public session environment variables`, () => {
      const result = envVarsSchema.safeParse({ [key]: 'user-controlled-secret' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain(key);
        expect(result.error.message).not.toContain('user-controlled-secret');
      }
    });

    it(`rejects persisted profile environment variable ${key} before attach`, () => {
      const metadata = parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: {
          sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          userId: 'user-1',
        },
        auth: { kiloSessionId: 'kilo_1' },
        profile: { envVars: { [key]: 'user-controlled-secret' } },
        lifecycle: { version: 1, timestamp: 1 },
      });

      expect(() => buildSessionAttachPayload(metadata)).toThrow(
        `Reserved control runtime environment variable: ${key}`
      );
    });

    it(`rejects persisted encrypted secret name ${key} before attach`, () => {
      const metadata = parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: {
          sessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          userId: 'user-1',
        },
        auth: { kiloSessionId: 'kilo_1' },
        profile: {
          encryptedSecrets: {
            [key]: {
              encryptedData: 'encrypted-secret-value',
              encryptedDEK: 'encrypted-data-key',
              algorithm: 'rsa-aes-256-gcm',
              version: 1,
            },
          },
        },
        lifecycle: { version: 1, timestamp: 1 },
      });

      expect(() => buildSessionAttachPayload(metadata)).toThrow(
        `Reserved control runtime environment variable: ${key}`
      );
    });
  }
});
