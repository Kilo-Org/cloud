import { describe, expect, it } from 'vitest';
import {
  CurrentSessionMetadataSchema,
  getEffectiveCredentialContainment,
  getSandboxProviderBinding,
  parseSessionMetadata,
  requiresContainmentSandbox,
  serializeSessionMetadata,
  type SessionMetadata,
} from './session-metadata.js';

const binding = {
  kind: 'e2b',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;
const credentialContainment = {
  github: false,
  gitlab: false,
  bitbucket: false,
  kilocode: false,
} as const;
const metadata = {
  metadataSchemaVersion: 2,
  identity: {
    sessionId: 'workspace_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    userId: 'oauth/user',
    orgId: binding.organizationId,
  },
  auth: { kiloSessionId: 'ses_12345678901234567890123456' },
  repository: { type: 'github', repo: 'acme/repo' },
  workspace: {
    sandboxId: 'ses-abcdef',
    sandboxProvider: 'e2b',
    sandboxProviderBinding: binding,
    credentialContainment,
  },
  lifecycle: { version: 1, timestamp: 1 },
} as const satisfies SessionMetadata;

describe('E2B metadata boundary', () => {
  it('round-trips the full identity and stored direct policy without changing schema version', () => {
    const parsed = parseSessionMetadata(metadata);
    expect(serializeSessionMetadata(parsed)).toEqual(metadata);
    expect(getSandboxProviderBinding(parsed)).toEqual(binding);
    expect(getEffectiveCredentialContainment(parsed)).toEqual(credentialContainment);
    expect(requiresContainmentSandbox(parsed)).toBe(false);
  });

  it('canonicalizes E2B UUIDs and the organization identity together', () => {
    const parsed = parseSessionMetadata({
      ...metadata,
      identity: { ...metadata.identity, orgId: binding.organizationId.toUpperCase() },
      workspace: {
        ...metadata.workspace,
        sandboxProviderBinding: {
          ...binding,
          organizationId: binding.organizationId.toUpperCase(),
          credentialId: binding.credentialId.toUpperCase(),
        },
      },
    });
    expect(parsed).toEqual(metadata);
  });

  it.each(['github', 'gitlab', 'bitbucket', 'kilocode'] as const)(
    'requires an explicit false %s flag and never applies a getter fallback',
    flag => {
      for (const value of [undefined, true]) {
        const invalid = {
          ...metadata,
          workspace: {
            ...metadata.workspace,
            credentialContainment: { ...credentialContainment, [flag]: value },
          },
        };
        expect(CurrentSessionMetadataSchema.safeParse(invalid).success).toBe(false);
        expect(() => parseSessionMetadata(invalid)).toThrow('Invalid current session metadata');
        expect(() => getEffectiveCredentialContainment(invalid as SessionMetadata)).toThrow(
          expect.objectContaining({ code: 'byoc_e2b_policy_mismatch' })
        );
      }
    }
  );

  it.each([
    { credentialContainment: undefined },
    { sandboxProviderBinding: undefined },
    { sandboxProviderBinding: { kind: 'e2b' } },
    { sandboxProviderBinding: { ...binding, credentialId: '' } },
    { sandboxProviderBinding: { ...binding, organizationId: 'not-a-uuid' } },
    { sandboxProviderBinding: { kind: 'e2b', source: { kind: 'platform' } } },
    { sandboxProviderBinding: { ...binding, source: { kind: 'platform' } } },
    { sandboxProvider: undefined },
    { sandboxProvider: 'cloudflare' },
    { sandboxProvider: 'vercel' },
    { sandboxId: undefined },
    { sandboxId: 'org-abcdef' },
    { sandboxId: 'istd-abcdef' },
    { sandboxId: 'crv-abcdef' },
    { sandboxId: 'dind-abcdef' },
    { sandboxAllocation: 'isolated-standard' },
    { devcontainerRequested: true },
    { managedScmContainment: true },
    { sandboxRoute: { kind: 'shared', routeKey: `org-${'a'.repeat(48)}` } },
    { providerRuntime: { provider: 'vercel', sessionId: 'another-runtime' } },
  ])('fails closed for incompatible E2B workspace metadata: %j', change => {
    const invalid = { ...metadata, workspace: { ...metadata.workspace, ...change } };
    expect(CurrentSessionMetadataSchema.safeParse(invalid).success).toBe(false);
    expect(() => parseSessionMetadata(invalid)).toThrow('Invalid current session metadata');
    expect(() => getSandboxProviderBinding(invalid as SessionMetadata)).toThrow(
      expect.objectContaining({ code: 'byoc_e2b_policy_mismatch' })
    );
  });

  it.each([
    { orgId: undefined },
    { orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    { sessionId: 'agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
  ])('rejects a personal, mismatched, or legacy identity: %j', change => {
    expect(() =>
      parseSessionMetadata({ ...metadata, identity: { ...metadata.identity, ...change } })
    ).toThrow('Invalid current session metadata');
  });

  it('rejects an already-prepared devcontainer', () => {
    expect(() =>
      parseSessionMetadata({
        ...metadata,
        devcontainer: {
          workspacePath: '/workspace',
          innerWorkspaceFolder: '/workspaces/repo',
          wrapperPort: 4173,
          configPath: '.devcontainer/devcontainer.json',
        },
      })
    ).toThrow('Invalid current session metadata');
  });

  it.each([
    { sandboxProvider: 'e2b' },
    { sandboxProviderBinding: binding },
    { workspace: { sandboxProvider: 'e2b' } },
    { workspace: { sandboxProviderBinding: binding } },
  ])('does not downgrade legacy-shaped E2B records to Cloudflare: %j', provider => {
    expect(() =>
      parseSessionMetadata({
        sessionId: metadata.identity.sessionId,
        userId: metadata.identity.userId,
        orgId: binding.organizationId,
        version: 1,
        timestamp: 1,
        ...provider,
      })
    ).toThrow('E2B sandboxes require current session metadata');
  });

  it.each([{ sandboxProvider: 'e2b' }, { sandboxProviderBinding: binding }])(
    'rejects flat E2B fields disguised with a current schema version: %j',
    provider => {
      const invalid = { ...metadata, workspace: undefined, ...provider };
      expect(CurrentSessionMetadataSchema.safeParse(invalid).success).toBe(false);
      expect(() => parseSessionMetadata(invalid)).toThrow('Invalid current session metadata');
    }
  );
});
