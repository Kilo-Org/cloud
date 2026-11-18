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
