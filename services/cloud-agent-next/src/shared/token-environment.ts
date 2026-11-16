/**
 * The deployment environment that the runtime admission check binds control
 * tokens to, matching the `env` claim the token minters set
 * (`process.env.NODE_ENV`): `production` for the deployed Worker and
 * `development` for local dev (`env.dev` / `.dev.vars`). Any other configured
 * value would refuse every admission, so normalize the two supported values.
 */
export function tokenEnvironment(env: { ENVIRONMENT?: string }): 'production' | 'development' {
  return env.ENVIRONMENT === 'production' ? 'production' : 'development';
}
