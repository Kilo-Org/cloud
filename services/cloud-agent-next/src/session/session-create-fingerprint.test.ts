import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  getSandbox: vi.fn(),
  ContainerProxy: class ContainerProxy {},
}));
vi.mock('@cloudflare/containers', () => ({}));
vi.mock('cloudflare:workers', () => ({ DurableObject: class DurableObject {} }));

import { sessionCreateIntentFingerprint } from './session-registration.js';
import type { SessionCreateRequest } from './session-requests.js';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';

const REQUEST: SessionCreateRequest = {
  initialTurn: { type: 'prompt', id: 'm', prompt: 'Fix the build' },
  agent: { mode: 'code', model: 'kilo/test-model' },
  repository: { type: 'github', repo: 'acme/widgets', branch: 'main' },
  options: { createdOnPlatform: 'cloud-agent-web', clientProvenance: 'browser' },
};

// Computed with the fingerprint function at HEAD, before `requestedEnvironment`
// and `requireEnvironmentChoice` existed. A request that sends neither must keep
// this hash, so a same-key retry of an existing create is not a new intent.
const FINGERPRINT_AT_HEAD = 'b3b6cc0bd0e984c4d340844a45833a4b377c82e616cc1af39a57dc219f5f0c52';

describe('session create intent fingerprint and the environment selection', () => {
  it('keeps the hash of a request that sends no environment selection', async () => {
    expect(await sessionCreateIntentFingerprint(REQUEST)).toBe(FINGERPRINT_AT_HEAD);
    expect(
      await sessionCreateIntentFingerprint({
        ...REQUEST,
        requestedEnvironment: undefined,
        requireEnvironmentChoice: undefined,
      })
    ).toBe(FINGERPRINT_AT_HEAD);
  });

  it('does not hash the environment that preflight resolved', async () => {
    expect(
      await sessionCreateIntentFingerprint({
        ...REQUEST,
        environment: {
          environmentId: ENVIRONMENT_ID,
          owner: { type: 'user', id: 'user-1' },
          configurationRevision: 2,
          repository: { platform: 'github', repoFullName: 'acme/widgets' },
        },
      })
    ).toBe(FINGERPRINT_AT_HEAD);
  });

  it('hashes the selected environment id', async () => {
    const selected = await sessionCreateIntentFingerprint({
      ...REQUEST,
      requestedEnvironment: { id: ENVIRONMENT_ID },
    });
    expect(selected).not.toBe(FINGERPRINT_AT_HEAD);
    expect(
      await sessionCreateIntentFingerprint({
        ...REQUEST,
        requestedEnvironment: { id: '22222222-2222-4222-8222-222222222222' },
      })
    ).not.toBe(selected);
  });

  it('hashes the branch requested for an additional repository', async () => {
    const withBranch = (branch: string | undefined) =>
      sessionCreateIntentFingerprint({
        ...REQUEST,
        requestedEnvironment: {
          id: ENVIRONMENT_ID,
          repositories: [{ repoFullName: 'acme/api', branch }],
        },
      });
    expect(await withBranch('feature/api')).not.toBe(await withBranch('other'));
    expect(await withBranch('feature/api')).not.toBe(await withBranch(undefined));
  });

  it('hashes the choice marker alone', async () => {
    expect(
      await sessionCreateIntentFingerprint({ ...REQUEST, requireEnvironmentChoice: true })
    ).not.toBe(FINGERPRINT_AT_HEAD);
  });

  it('hashes the same selection the same way for any entry order, case or empty list', async () => {
    const select = (repositories: { repoFullName: string; branch?: string }[] | undefined) =>
      sessionCreateIntentFingerprint({
        ...REQUEST,
        requestedEnvironment: { id: ENVIRONMENT_ID, repositories },
      });
    const sorted = await select([
      { repoFullName: 'acme/api', branch: 'a' },
      { repoFullName: 'acme/web', branch: 'b' },
    ]);
    expect(
      await select([
        { repoFullName: ' Acme/Web ', branch: 'b' },
        { repoFullName: 'ACME/api', branch: 'a' },
      ])
    ).toBe(sorted);
    const bare = await sessionCreateIntentFingerprint({
      ...REQUEST,
      requestedEnvironment: { id: ENVIRONMENT_ID },
    });
    expect(await select([])).toBe(bare);
    expect(await select(undefined)).toBe(bare);
    expect(sorted).not.toBe(bare);
  });
});
