export const PNPM_STORE_DIR = '/var/cache/kilo/pnpm-store';
export const PNPM_STORE_ENV_VAR = 'pnpm_config_store_dir';

/**
 * Git configuration the platform pins for every sandbox: a read-only credential
 * helper that redeems Kilo capabilities at the outbound interceptor.
 *
 * Spread *after* user-supplied env vars in the runtime environment so these
 * values always win.
 *
 * `GIT_CONFIG_VALUE_0` must match the `COPY` destination in `Dockerfile`,
 * `Dockerfile.dind`, and `Dockerfile.dev`; nothing at build or test time ties
 * the two together, and a mismatch only surfaces as a runtime helper warning.
 */
export const SYSTEM_GIT_CONFIG_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '/opt/kilo-cloud/kilo-git-credential',
  GIT_CONFIG_KEY_1: 'credential.useHttpPath',
  GIT_CONFIG_VALUE_1: 'false',
} as const;

const SYSTEM_GIT_CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(SYSTEM_GIT_CONFIG_ENV));

/**
 * True for a `GIT_CONFIG_*` env var that never reaches the sandbox because the
 * platform owns git's configuration.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` point git at a config file whose
 * `credential.helper` entries are read *before* the enumerated slots above, and
 * `GIT_CONFIG_PARAMETERS` is applied last, where an empty `credential.helper=`
 * resets every helper ahead of it. Either would displace the pinned helper. The
 * slots the platform sets itself are kept — `SYSTEM_GIT_CONFIG_ENV`
 * is spread last, so a user-supplied `GIT_CONFIG_KEY_<n>` beyond
 * `GIT_CONFIG_COUNT` is inert anyway; dropping it keeps the sandbox environment
 * a faithful reflection of the profile it was built from.
 */
export function isStrippedGitConfigEnvVar(key: string): boolean {
  return key.startsWith('GIT_CONFIG_') && !SYSTEM_GIT_CONFIG_KEYS.has(key);
}
