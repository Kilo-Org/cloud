import jwt from 'jsonwebtoken';

/**
 * A bearer carrying modern control-policy claims (`aud`, `tokenPurpose`, or
 * `credentialExchange`) is re-verified when runtime authorization is created,
 * so callers must not treat its original claims as end-user model credentials.
 * `authMiddleware` has already verified the bearer against its audience and
 * current pepper; decoding here only selects the compatibility path.
 */
export function isPolicyBearingAuthToken(token: string): boolean {
  const claims = jwt.decode(token);
  return (
    claims !== null &&
    typeof claims === 'object' &&
    ('aud' in claims || 'tokenPurpose' in claims || 'credentialExchange' in claims)
  );
}
