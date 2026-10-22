import { describe, expect, it } from 'vitest';
import { MASKED_SECRET_VALUE } from './types';
import {
  assertValidEnvironmentKey,
  isReservedEnvironmentKey,
  resolveEnvironmentIdentity,
  validateEnvironmentCommands,
  validateEnvironmentName,
  validateEnvironmentPlainVars,
  validateEnvironmentSecretValue,
  validateEnvironmentSecrets,
  validateEnvironmentVarCount,
} from './environment-contracts';

describe('reserved environment keys', () => {
  it('rejects runtime-owned names and prefixes', () => {
    for (const key of [
      'HOME',
      'SESSION_ID',
      'SESSION_HOME',
      'pnpm_config_store_dir',
      'SANDBOX_CONTROL_CREDENTIAL',
      'SANDBOX_CONTROL_URL',
      'PROVIDER_INSTANCE_ID',
      'CONTROL_LOG_UPLOAD_URL',
      'CONTROL_LOG_UPLOAD_GRANT',
      'CONTROL_WRAPPER_INSTANCE_ID',
      'XDG_DATA_HOME',
      'KILOCODE_TOKEN',
      'KILO_PLATFORM',
      'OPENCODE_CONFIG_CONTENT',
    ]) {
      expect(isReservedEnvironmentKey(key)).toBe(true);
      expect(() => assertValidEnvironmentKey(key)).toThrow();
    }
  });

  it('allows tokens the sandbox does not own', () => {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'BITBUCKET_TOKEN', 'MY_VAR']) {
      expect(isReservedEnvironmentKey(key)).toBe(false);
      expect(() => assertValidEnvironmentKey(key)).not.toThrow();
    }
  });

  it('rejects malformed keys', () => {
    for (const key of ['', '1ABC', 'foo-bar', 'A B']) {
      expect(() => assertValidEnvironmentKey(key)).toThrow();
    }
  });
});

describe('environment value limits', () => {
  it('caps plaintext values at 256 characters', () => {
    expect(() => validateEnvironmentPlainVars({ FOO: 'x'.repeat(257) })).toThrow();
    expect(validateEnvironmentPlainVars({ FOO: 'x'.repeat(256) })).toEqual({
      FOO: 'x'.repeat(256),
    });
  });

  it('caps secret values at 8192 characters', () => {
    expect(() => validateEnvironmentSecretValue('x'.repeat(8193))).toThrow();
    expect(validateEnvironmentSecretValue('x'.repeat(8192))).toHaveLength(8192);
  });

  it('rejects a masked placeholder as a secret value', () => {
    expect(() => validateEnvironmentSecrets({ API_KEY: MASKED_SECRET_VALUE })).toThrow();
  });

  it('caps commands at 20', () => {
    expect(() => validateEnvironmentCommands(['echo first', 'echo second'])).toThrow();
    expect(() => validateEnvironmentCommands(['x'.repeat(16_001)])).toThrow();
    expect(() => validateEnvironmentCommands([''])).toThrow();
    expect(validateEnvironmentCommands(['echo'])).toEqual(['echo']);
  });

  it('caps combined variables and secrets at 50', () => {
    expect(() => validateEnvironmentVarCount(51)).toThrow();
    expect(() => validateEnvironmentVarCount(50)).not.toThrow();
  });

  it('trims and bounds the environment name', () => {
    expect(validateEnvironmentName('  staging  ')).toBe('staging');
    expect(() => validateEnvironmentName('   ')).toThrow();
    expect(() => validateEnvironmentName('x'.repeat(101))).toThrow();
  });
});

describe('resolveEnvironmentIdentity', () => {
  it('lowercases the GitHub repository path and nulls the other identities', () => {
    expect(
      resolveEnvironmentIdentity({ platform: 'github', repoFullName: 'Acme/Widgets' })
    ).toEqual({
      repo_full_name: 'acme/widgets',
      gitlab_clone_url: null,
      bitbucket_workspace_uuid: null,
      bitbucket_repository_uuid: null,
    });
  });

  it('keeps only the GitLab clone URL', () => {
    expect(
      resolveEnvironmentIdentity({
        platform: 'gitlab',
        repoFullName: 'Group/Project',
        gitlabCloneUrl: 'https://gitlab.com/group/project.git',
        bitbucketWorkspaceUuid: '11111111-1111-4111-8111-111111111111',
      })
    ).toEqual({
      repo_full_name: 'group/project',
      gitlab_clone_url: 'https://gitlab.com/group/project.git',
      bitbucket_workspace_uuid: null,
      bitbucket_repository_uuid: null,
    });
  });

  it('requires a GitLab clone URL', () => {
    expect(() =>
      resolveEnvironmentIdentity({ platform: 'gitlab', repoFullName: 'group/project' })
    ).toThrow();
  });

  it('keeps only the lowercased Bitbucket UUID pair', () => {
    expect(
      resolveEnvironmentIdentity({
        platform: 'bitbucket',
        repoFullName: 'Team/Repo',
        bitbucketWorkspaceUuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        bitbucketRepositoryUuid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      })
    ).toEqual({
      repo_full_name: 'team/repo',
      gitlab_clone_url: null,
      bitbucket_workspace_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      bitbucket_repository_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
  });

  it('rejects a Bitbucket identity missing a UUID', () => {
    expect(() =>
      resolveEnvironmentIdentity({
        platform: 'bitbucket',
        repoFullName: 'team/repo',
        bitbucketWorkspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })
    ).toThrow();
  });
});
