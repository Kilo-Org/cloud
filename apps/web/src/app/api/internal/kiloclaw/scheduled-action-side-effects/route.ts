/**
 * Internal API endpoint: scheduled-action notification side effects.
 *
 * Called by the kiloclaw worker's notice-sweep cron for the `email`
 * channel. The sweep dispatches `mobile_push` directly via the
 * NOTIFICATIONS service binding (worker-to-worker) and treats `webapp`
 * as a no-op (the banner reads its state from `kiloclaw.getStatus`),
 * so this endpoint only handles email today. The shape is generic
 * enough that future channels can be wired here without API churn.
 *
 * URL: POST /api/internal/kiloclaw/scheduled-action-side-effects
 * Auth: X-Internal-Secret header.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { send as sendEmail, RawHtml, type TemplateName } from '@/lib/email';

// Constant-time comparison so a public attacker can't probe the
// internal-api secret via response-timing differences. HMAC both
// inputs with a fixed key so timingSafeEqual always sees fixed-length
// (sha256 = 32 bytes) buffers — this avoids any branch on length and
// any padding-prefix corner case. The HMAC key doesn't need to be
// secret; it just normalizes both sides to a uniform-distribution
// 32-byte digest so the byte-by-byte compare is meaningful.
const SECRET_COMPARE_HMAC_KEY = Buffer.from('kiloclaw-internal-secret-compare');

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHmac('sha256', SECRET_COMPARE_HMAC_KEY).update(provided).digest();
  const b = createHmac('sha256', SECRET_COMPARE_HMAC_KEY).update(expected).digest();
  return timingSafeEqual(a, b);
}

// Mirrors the body the sweep sends. Defensive but not exhaustive — we
// only read the fields we need for the email path. Other channels can
// add their own optional fields without breaking this validator.
const BodySchema = z.object({
  notificationId: z.string().uuid(),
  kind: z.enum(['notice', 'cancelled']),
  channel: z.enum(['email', 'webapp', 'mobile_push', 'agent']),
  targetId: z.string().uuid(),
  scheduledActionId: z.string().uuid(),
  actionType: z.enum(['scheduled_restart', 'version_change']),
  userId: z.string(),
  userEmail: z.string().nullable(),
  userName: z.string().nullable(),
  instanceId: z.string().uuid(),
  instanceSandboxId: z.string(),
  instanceName: z.string().nullable().optional(),
  sourceImageTag: z.string().nullable(),
  sourceOpenclawVersion: z.string().nullable(),
  targetImageTag: z.string().nullable(),
  targetOpenclawVersion: z.string().nullable(),
  overridePins: z.boolean(),
  scheduledAt: z.string(),
  noticeLeadHours: z.number(),
  noticeSubject: z.string(),
  noticeBody: z.string(),
  reason: z.string().nullable(),
});

type Body = z.infer<typeof BodySchema>;

function pickTemplate(actionType: Body['actionType'], kind: Body['kind']): TemplateName {
  if (actionType === 'scheduled_restart') {
    return kind === 'notice' ? 'clawScheduledRestartNotice' : 'clawScheduledRestartCancelled';
  }
  return kind === 'notice'
    ? 'clawScheduledVersionChangeNotice'
    : 'clawScheduledVersionChangeCancelled';
}

function formatScheduledAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // Local-leaning format that's still legible across zones.
    return (
      d.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }) + ' UTC'
    );
  } catch {
    return iso;
  }
}

function firstName(fullName: string | null): string {
  if (!fullName) return 'there';
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

function instanceDisplay(sandboxId: string, name: string | null | undefined): string {
  // End users recognize their bot by the name they gave it; the long
  // sandbox id in the body is just debug info that wraps badly in a
  // narrow email column. When a name is set we render only the name.
  // Fallback to the sandbox id only when the user hasn't named the
  // instance — rare in practice.
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return sandboxId;
}

function adminMessageSection(noticeBody: string): RawHtml {
  const trimmed = noticeBody.trim();
  if (!trimmed) return new RawHtml('');
  // Render newlines as <br/>; light-touch escape since the admin
  // wrote this. Full HTML in admin-authored messages is risky enough
  // that we paragraph-wrap-and-escape rather than renderTemplate's
  // default escape (which would collapse newlines).
  const escaped = trimmed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br />');
  return new RawHtml(
    `<p style="background-color: #f5f5f5; padding: 12px 16px; border-radius: 6px; font-style: italic">${escaped}</p>`
  );
}

function versionChangeSection(body: Body): string {
  const sourceLabel =
    body.sourceImageTag && body.sourceOpenclawVersion
      ? `${body.sourceImageTag} (OpenClaw ${body.sourceOpenclawVersion})`
      : (body.sourceImageTag ?? 'current version');
  const targetLabel =
    body.targetImageTag && body.targetOpenclawVersion
      ? `${body.targetImageTag} (OpenClaw ${body.targetOpenclawVersion})`
      : (body.targetImageTag ?? 'a new version');
  return `Upgrading from ${sourceLabel} to ${targetLabel}.`;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('X-Internal-Secret');
  if (!INTERNAL_API_SECRET || !secretMatches(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody: unknown = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const body = parsed.data;

  // Only the email channel is dispatched through this endpoint. The
  // sweep routes mobile_push to the NOTIFICATIONS service binding
  // directly and treats webapp as a no-op, so any non-email request
  // is a routing bug. Return 400 (not 200 'skipped') so the sweep
  // marks the row failed with a legible error_message instead of
  // recording a phantom 'sent' for a notification that never went
  // out.
  if (body.channel !== 'email') {
    return NextResponse.json(
      { error: `channel ${body.channel} not handled by web endpoint` },
      { status: 400 }
    );
  }

  if (!body.userEmail) {
    // 422 (not 200) so the sweep marks the row as failed with a clear
    // error_message. Returning 200 here would record the row as 'sent'
    // even though no email was actually delivered, which is misleading
    // when an admin is investigating why a user didn't receive a notice.
    return NextResponse.json({ error: 'no user email' }, { status: 422 });
  }

  const templateName = pickTemplate(body.actionType, body.kind);
  const templateVars = {
    user_first_name: firstName(body.userName),
    instance_name: instanceDisplay(body.instanceSandboxId, body.instanceName ?? null),
    scheduled_at_display: formatScheduledAt(body.scheduledAt),
    admin_message_section: adminMessageSection(body.noticeBody),
    ...(body.actionType === 'version_change'
      ? { version_change_section: versionChangeSection(body) }
      : {}),
  };

  // Only the heads-up notice borrows the admin-authored subject. The
  // cancellation email is a follow-up announcing the schedule is off,
  // so reusing the original notice subject (e.g. "Restart tonight") in
  // an inbox row that actually says "the previously scheduled restart
  // has been cancelled" is misleading. Falling through to undefined
  // here lets the cancellation template's default subject render.
  const subjectOverride =
    body.kind === 'notice' ? body.noticeSubject.trim() || undefined : undefined;

  try {
    const result = await sendEmail({
      to: body.userEmail,
      templateName,
      templateVars,
      subjectOverride,
    });
    if (!result.sent) {
      // 422 (not 200) so the sweep marks the row failed with a legible
      // error_message instead of recording it as 'sent' when the email
      // didn't actually go out (provider misconfigured, NeverBounce
      // rejected, etc.). Same treatment as the missing-email case above.
      return NextResponse.json({ error: `email not sent: ${result.reason}` }, { status: 422 });
    }
    return NextResponse.json({ sent: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scheduled-action-side-effects] email send failed', {
      notificationId: body.notificationId,
      error: msg,
    });
    return NextResponse.json({ error: 'send failed' }, { status: 502 });
  }
}
