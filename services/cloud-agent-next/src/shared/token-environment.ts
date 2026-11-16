/**
 * The deployment environment that the runtime admission check binds control
 * tokens to, matching the `env` claim the token minters set
 * (`process.env.NODE_ENV`): `production` for the deployed Worker and
 * `development` only when the configuration names it. Anything else resolves
 * to `production`, so a missing or misspelled value refuses development-labeled
 * tokens rather than admitting them.
 */
export function tokenEnvironment(env: { ENVIRONMENT?: string }): 'production' | 'development' {
  return env.ENVIRONMENT === 'development' ? 'development' : 'production';
}
