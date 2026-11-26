/**
 * The audience a runtime credential needs for the model availability check:
 * the web API serves the organization catalogue, and the gateway serves the
 * personal one.
 */
export function modelValidationAudience(
  env: { KILOCODE_ORG_ID_OVERRIDE?: string },
  originalOrganizationId: string | undefined
): 'kilo-api' | 'kilo-gateway' {
  return (env.KILOCODE_ORG_ID_OVERRIDE ?? originalOrganizationId) ? 'kilo-api' : 'kilo-gateway';
}
