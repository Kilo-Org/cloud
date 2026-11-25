import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { previewTargetSchema } from './shared/preview-target.js';
import { AGENT_SANDBOX_PROVIDERS } from './shared/sandbox-provider.js';

/**
 * The claims an entry ticket carries. The parse keeps only the declared
 * fields, so declare a claim here before reading it.
 */
const streamTicketPayloadSchema = z.object({
  type: z.literal('stream_ticket'),
  exp: z.number(),
  aud: z.string().optional(),
  purpose: z.enum(['stream', 'terminal', 'preview']).optional(),
  userId: z.string().optional(),
  kiloSessionId: z.string().optional(),
  cloudAgentSessionId: z.string().optional(),
  sessionId: z.string().optional(),
  worktreeId: z.string().optional(),
  organizationId: z.string().optional(),
  ptyId: z.string().optional(),
  port: z.number().optional(),
  nonce: z.string().optional(),
});

type StreamTicketPayload = z.infer<typeof streamTicketPayloadSchema>;

export const STREAM_TICKET_AUDIENCE = 'cloud-agent-stream';
export const TERMINAL_TICKET_AUDIENCE = 'cloud-agent-terminal';
export const PREVIEW_TICKET_AUDIENCE = 'cloud-agent-preview';
export const PREVIEW_SESSION_AUDIENCE = 'cloud-agent-preview-session';

/** The claims an entry ticket carries: who may open which target on which port. */
const previewEntryClaimsSchema = z.intersection(
  z.object({
    userId: z.string().min(1),
    port: z.number().int(),
    organizationId: z.string().optional(),
  }),
  previewTargetSchema
);

export type PreviewEntryClaims = z.infer<typeof previewEntryClaimsSchema>;

/**
 * A minted preview cookie is bound to the exact allocation it was opened
 * against. The shared target is mutually exclusive, so a token cannot name both
 * a worktree and a session.
 */
const previewClaimsSchema = z.intersection(
  previewEntryClaimsSchema,
  z.object({
    provider: z.enum(AGENT_SANDBOX_PROVIDERS),
    logicalSandboxId: z.string().min(1),
    allocationRef: z.string().min(1),
  })
);

export type PreviewClaims = z.infer<typeof previewClaimsSchema>;

/** A preview token must expire; `jwt.verify` accepts a token without `exp`. */
const previewTokenPayloadSchema = z.intersection(
  previewClaimsSchema,
  z.object({ exp: z.number() })
);

export type SecretBinding = string | { get(): Promise<string> };

export async function resolveSecret(
  secret: SecretBinding | null | undefined
): Promise<string | null> {
  if (!secret) {
    return null;
  }
  if (typeof secret === 'string') {
    return secret;
  }

  try {
    return await secret.get();
  } catch {
    return null;
  }
}

export function validateStreamTicket(
  ticket: string | null,
  secret: string | null | undefined,
  expectedAudience: string
): { success: true; payload: StreamTicketPayload } | { success: false; error: string } {
  if (!ticket) {
    return { success: false, error: 'Missing stream ticket' };
  }
  if (!secret) {
    return { success: false, error: 'NEXTAUTH_SECRET is not configured on the worker' };
  }

  try {
    const verified: unknown = jwt.verify(ticket, secret, {
      algorithms: ['HS256'],
    });

    const parsed = streamTicketPayloadSchema.safeParse(verified);
    if (!parsed.success) {
      return { success: false, error: 'Invalid ticket payload' };
    }

    if (parsed.data.aud !== expectedAudience) {
      return { success: false, error: 'Invalid ticket audience' };
    }

    return { success: true, payload: parsed.data };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Ticket expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid ticket signature' };
    }
    return { success: false, error: 'Ticket validation failed' };
  }
}

export const PREVIEW_SESSION_LIFETIME_SECONDS = 3600;

export function mintPreviewSessionToken(
  claims: PreviewClaims,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  return jwt.sign(
    { ...claims, type: 'preview_session', exp: nowSeconds + PREVIEW_SESSION_LIFETIME_SECONDS },
    secret,
    { algorithm: 'HS256', noTimestamp: true, audience: PREVIEW_SESSION_AUDIENCE }
  );
}

export type PreviewTokenValidation =
  | { success: true; claims: PreviewClaims }
  | { success: false; error: string };

const INVALID_PREVIEW_CLAIMS = { success: false, error: 'Invalid preview claims' } as const;

/** The object strips every other field, so `aud`, `exp` and `type` never reach the claims. */
function previewClaimsFrom(payload: unknown): PreviewTokenValidation {
  const parsed = previewTokenPayloadSchema.safeParse(payload);
  if (!parsed.success) return INVALID_PREVIEW_CLAIMS;
  const { exp: _exp, ...claims } = parsed.data;
  return { success: true, claims };
}

export type PreviewEntryTicketValidation =
  | { success: true; claims: PreviewEntryClaims; nonce: string; expiresAtMs: number }
  | { success: false; error: string };

/** The entry carries the single-use `nonce` and its expiry apart from the claims. */
const previewEntryTicketSchema = z.intersection(
  previewEntryClaimsSchema,
  z.object({ exp: z.number(), nonce: z.string().min(1) })
);

/** The 60-second entry ticket the web app mints (a `stream_ticket` with purpose `preview`). */
export function validatePreviewEntryTicket(
  ticket: string | null,
  secret: string | null | undefined
): PreviewEntryTicketValidation {
  const validated = validateStreamTicket(ticket, secret, PREVIEW_TICKET_AUDIENCE);
  if (!validated.success) return validated;
  if (validated.payload.purpose !== 'preview') {
    return { success: false, error: 'Invalid ticket purpose' };
  }
  const parsed = previewEntryTicketSchema.safeParse(validated.payload);
  if (!parsed.success) return INVALID_PREVIEW_CLAIMS;
  const { exp, nonce, ...claims } = parsed.data;
  return { success: true, claims, nonce, expiresAtMs: exp * 1000 };
}

/** The host-bound session token the Worker sets as the preview cookie. */
export function validatePreviewSessionToken(
  token: string | null,
  secret: string | null | undefined
): PreviewTokenValidation {
  if (!token) return { success: false, error: 'Missing preview session' };
  if (!secret) {
    return { success: false, error: 'NEXTAUTH_SECRET is not configured on the worker' };
  }
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: PREVIEW_SESSION_AUDIENCE,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Preview session expired' };
    }
    return { success: false, error: 'Invalid preview session' };
  }
  if (typeof payload === 'string' || payload.type !== 'preview_session') {
    return { success: false, error: 'Invalid preview session type' };
  }
  return previewClaimsFrom(payload);
}
