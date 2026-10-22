import * as z from 'zod';
import type {
  AuthenticationExtensionsClientOutputs,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

/**
 * Request-boundary schemas for the WebAuthn responses the passkey routes accept.
 *
 * Verification stays with `@simplewebauthn/server`: `verifyRegistrationResponse`
 * and `verifyAuthenticationResponse` decode the client data, compare the
 * challenge, origin and rpId, and check the signature against the stored public
 * key. These schemas only make the type the routes hand to those helpers a
 * runtime fact, so a body that is not a WebAuthn response is refused as a bad
 * request instead of being asserted into one.
 */

/** A base64url member: non-empty text. The verifier decodes it and bounds it. */
const base64UrlStringSchema = z.string().min(1);

/**
 * Client extension outputs are opaque to this relying party: the verifier never
 * reads them, and their wire form differs from the browser's object type, so
 * only presence as an object is checked. A native security-key assertion omits
 * them, which carries the same meaning as no output at all, so absence
 * defaults to `{}`.
 */
const clientExtensionResultsSchema = z
  .custom<AuthenticationExtensionsClientOutputs>(
    value => typeof value === 'object' && value !== null && !Array.isArray(value)
  )
  .optional()
  .default({});

const authenticatorAttachmentSchema = z.enum(['platform', 'cross-platform']);

/** The `navigator.credentials.create()` result, JSON-encoded. */
export const registrationResponseSchema: z.ZodType<RegistrationResponseJSON> = z.object({
  id: base64UrlStringSchema,
  rawId: base64UrlStringSchema,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64UrlStringSchema,
    attestationObject: base64UrlStringSchema,
    authenticatorData: base64UrlStringSchema.optional(),
    transports: z.array(z.string()).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64UrlStringSchema.optional(),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema.optional(),
  clientExtensionResults: clientExtensionResultsSchema,
});

/** The `navigator.credentials.get()` result, JSON-encoded. */
export const authenticationResponseSchema: z.ZodType<AuthenticationResponseJSON> = z.object({
  id: base64UrlStringSchema,
  rawId: base64UrlStringSchema,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64UrlStringSchema,
    authenticatorData: base64UrlStringSchema,
    signature: base64UrlStringSchema,
    // The verifier ignores a user handle it cannot use, and a native
    // authenticator may report an empty one, so any string is accepted here.
    userHandle: z.string().optional(),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema.optional(),
  clientExtensionResults: clientExtensionResultsSchema,
});
