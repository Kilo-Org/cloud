import { z } from 'zod';
import { UtsAudienceSchema } from './token';

/**
 * The sign-in surface of the mint Worker on the issuer origin (design 5.1, 5.4, 5.14): the passkey
 * ceremonies of the sign-in pages, the RFC 8628 device grant and the one-time tickets.
 */

/** RFC 8628 section 3.1: the device authorization endpoint. */
export const UTS_DEVICE_AUTHORIZATION_PATH = '/device_authorization';
/** RFC 8628 section 3.3: the page where the user enters the user code and approves the device. */
export const UTS_DEVICE_VERIFICATION_PATH = '/device';
/** The approval page's decision, a JSON POST from that page. */
export const UTS_DEVICE_DECISION_PATH = '/device/decision';

/** The passkey pages' JSON calls: ceremony options, then the authenticator's response. */
export const UTS_PASSKEY_OPTIONS_PATH = '/signin/passkey/options';
export const UTS_PASSKEY_VERIFY_PATH = '/signin/passkey/verify';
/** The page where a signed-in user adds a passkey. */
export const UTS_PASSKEYS_PAGE_PATH = '/signin/passkeys';
/** The one script of the sign-in pages. */
export const UTS_SIGNIN_SCRIPT_PATH = '/signin/assets/signin.js';

/** One-time tickets: minted from a first-party grant, redeemed once by their audience. */
export const UTS_TICKETS_PATH = '/tickets';
export const UTS_TICKET_REDEEM_PATH = '/tickets/redeem';

/** Design 5.3: a device code lives 10 minutes; RFC 8628 section 3.2 polls every 5 seconds. */
export const UTS_DEVICE_CODE_LIFETIME_SECONDS = 600;
export const UTS_DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Design 5.3: a one-time ticket lives 60 seconds and is consumed by its first redemption. */
export const UTS_TICKET_LIFETIME_SECONDS = 60;

/** RFC 8628 section 3.2. */
export const DeviceAuthorizationResponseSchema = z.strictObject({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type DeviceAuthorizationResponse = z.infer<typeof DeviceAuthorizationResponseSchema>;

/** What a ticket opens on its audience. `sign_in` is not minted from a grant. */
export const UTS_TICKET_PURPOSES = [
  'stream',
  'terminal',
  'preview',
  'dispatch',
  'download',
] as const;
export const UtsTicketPurposeSchema = z.enum(UTS_TICKET_PURPOSES);
export type UtsTicketPurpose = z.infer<typeof UtsTicketPurposeSchema>;

/** The service object a ticket opens, such as a session id: visible ASCII, at most 256. */
export const UtsTicketResourceSchema = z.string().regex(/^[\x21-\x7e]{1,256}$/);

export const TicketResponseSchema = z.strictObject({
  ticket: z.string().min(1),
  expires_in: z.number().int().positive(),
  purpose: UtsTicketPurposeSchema,
  audience: UtsAudienceSchema,
});
export type TicketResponse = z.infer<typeof TicketResponseSchema>;

/**
 * A redeemed ticket: the account it was minted for (`sub`), the grant (`sid`) and client it was
 * minted from, and the organization that grant is bound to.
 */
export const TicketRedemptionSchema = z.strictObject({
  sub: z.string().min(1),
  sid: z.uuid(),
  client_id: z.string().min(1),
  purpose: UtsTicketPurposeSchema,
  audience: UtsAudienceSchema,
  resource: UtsTicketResourceSchema.optional(),
  org: z.uuid().optional(),
});
export type TicketRedemption = z.infer<typeof TicketRedemptionSchema>;

/** Every ticket that cannot be redeemed (unknown, used, expired, another audience) answers this. */
export const TicketRefusalSchema = z.strictObject({ error: z.literal('invalid_ticket') });
