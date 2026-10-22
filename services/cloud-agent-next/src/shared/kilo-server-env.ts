export const KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS_ENV =
  'KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS';

/**
 * Worker-owned env keys forwarded to the wrapper process so the Kilo server
 * inherits them (e.g. the experimental bash default timeout). Unlike
 * `TOOL_CGROUP_*` these are not org-gated: a key is forwarded only when it is
 * set in the Worker environment, so presence in the deployed config is the
 * rollout control.
 */
export const KILO_SERVER_ENV_KEYS = [KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS_ENV] as const;

export type KiloServerEnvKey = (typeof KILO_SERVER_ENV_KEYS)[number];
export type KiloServerEnv = Partial<Record<KiloServerEnvKey, string>>;

/**
 * Code Reviewer sessions run with platform-provided configuration only: the
 * Kilo server ignores project-level config, plugins, instructions and skills
 * in the reviewed checkout. Platform rules and skills under the session HOME
 * still load.
 */
const CODE_REVIEW_KILO_SERVER_ENV: Readonly<Record<string, string>> = {
  KILO_DISABLE_PROJECT_CONFIG: '1',
  KILO_DISABLE_EXTERNAL_SKILLS: '1',
};

export function kiloServerEnvForOrigin(
  createdOnPlatform: string | undefined
): Readonly<Record<string, string>> {
  return createdOnPlatform === 'code-review' ? CODE_REVIEW_KILO_SERVER_ENV : {};
}
