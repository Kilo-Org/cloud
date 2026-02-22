import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TownConfigSchema } from '../../src/types';

// We can't import the actual config functions because they depend on
// DurableObjectStorage. Instead, test the merge logic directly.

/**
 * Reproduces the merge logic from config.ts updateTownConfig.
 */
function mergeTownConfig(
  current: ReturnType<typeof TownConfigSchema.parse>,
  update: Partial<ReturnType<typeof TownConfigSchema.parse>>
) {
  // env_vars masked-value preservation
  let resolvedEnvVars = current.env_vars;
  if (update.env_vars) {
    resolvedEnvVars = {};
    for (const [key, value] of Object.entries(update.env_vars)) {
      resolvedEnvVars[key] = value.startsWith('****') ? (current.env_vars[key] ?? value) : value;
    }
  }

  // git_auth masked-value preservation
  let resolvedGitAuth = current.git_auth;
  if (update.git_auth) {
    resolvedGitAuth = { ...current.git_auth };
    for (const key of ['github_token', 'gitlab_token', 'gitlab_instance_url'] as const) {
      const incoming = update.git_auth[key];
      if (incoming === undefined) continue;
      resolvedGitAuth[key] = incoming.startsWith('****')
        ? (current.git_auth[key] ?? incoming)
        : incoming;
    }
    // platform_integration_id is not masked
    if (update.git_auth.platform_integration_id !== undefined) {
      resolvedGitAuth.platform_integration_id = update.git_auth.platform_integration_id;
    }
  }

  return TownConfigSchema.parse({
    ...current,
    ...update,
    env_vars: resolvedEnvVars,
    git_auth: resolvedGitAuth,
  });
}

describe('town config merge logic', () => {
  const defaultConfig = () =>
    TownConfigSchema.parse({
      env_vars: {},
      git_auth: {},
    });

  describe('git_auth masked-value preservation', () => {
    it('preserves real github_token when masked value is sent', () => {
      const current = TownConfigSchema.parse({
        git_auth: { github_token: 'ghs_realtoken123456' },
      });
      const update = { git_auth: { github_token: '****3456' } };
      const result = mergeTownConfig(current, update);
      expect(result.git_auth.github_token).toBe('ghs_realtoken123456');
    });

    it('preserves real gitlab_token when masked value is sent', () => {
      const current = TownConfigSchema.parse({
        git_auth: { gitlab_token: 'glpat-realtoken789' },
      });
      const update = { git_auth: { gitlab_token: '****t789' } };
      const result = mergeTownConfig(current, update);
      expect(result.git_auth.gitlab_token).toBe('glpat-realtoken789');
    });

    it('updates github_token when real value is sent', () => {
      const current = TownConfigSchema.parse({
        git_auth: { github_token: 'ghs_old_token' },
      });
      const update = { git_auth: { github_token: 'ghs_new_token' } };
      const result = mergeTownConfig(current, update);
      expect(result.git_auth.github_token).toBe('ghs_new_token');
    });

    it('preserves existing tokens when only gitlab_instance_url is updated', () => {
      const current = TownConfigSchema.parse({
        git_auth: {
          gitlab_token: 'glpat-mytoken',
          gitlab_instance_url: 'https://gitlab.example.com',
        },
      });
      const update = { git_auth: { gitlab_instance_url: 'https://gitlab.newhost.com' } };
      const result = mergeTownConfig(current, update);
      expect(result.git_auth.gitlab_token).toBe('glpat-mytoken');
      expect(result.git_auth.gitlab_instance_url).toBe('https://gitlab.newhost.com');
    });

    it('preserves platform_integration_id across updates', () => {
      const current = TownConfigSchema.parse({
        git_auth: {
          github_token: 'ghs_token',
          platform_integration_id: 'int-123',
        },
      });
      const update = {
        git_auth: { github_token: 'ghs_fresh_token', platform_integration_id: 'int-123' },
      };
      const result = mergeTownConfig(current, update);
      expect(result.git_auth.github_token).toBe('ghs_fresh_token');
      expect(result.git_auth.platform_integration_id).toBe('int-123');
    });
  });

  describe('env_vars masked-value preservation', () => {
    it('preserves real value when masked value is sent', () => {
      const current = TownConfigSchema.parse({
        env_vars: { SECRET_KEY: 'real_secret_value' },
      });
      const update = { env_vars: { SECRET_KEY: '****alue' } };
      const result = mergeTownConfig(current, update);
      expect(result.env_vars.SECRET_KEY).toBe('real_secret_value');
    });

    it('updates value when real value is sent', () => {
      const current = TownConfigSchema.parse({
        env_vars: { API_KEY: 'old_key' },
      });
      const update = { env_vars: { API_KEY: 'new_key' } };
      const result = mergeTownConfig(current, update);
      expect(result.env_vars.API_KEY).toBe('new_key');
    });
  });
});
