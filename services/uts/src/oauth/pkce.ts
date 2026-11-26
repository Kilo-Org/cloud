import { z } from 'zod';
import { base64url, sha256 } from '../token/credentials';

/** RFC 7636, section 4.1: 43 to 128 unreserved characters. */
export const CodeVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/** RFC 7636, section 4.2: an S256 challenge is base64url of a SHA-256 digest. */
export const CodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The S256 challenge of a verifier, `BASE64URL(SHA256(ASCII(code_verifier)))`. */
export async function s256Challenge(verifier: string): Promise<string> {
  return base64url(await sha256(CodeVerifierSchema.parse(verifier)));
}
