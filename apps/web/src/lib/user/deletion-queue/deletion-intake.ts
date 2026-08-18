import { z } from 'zod';

const KILO_OWNED_DOMAINS = ['kilocode.ai', 'kilo.ai'] as const;
const PYLON_TICKET_RE = /^[\w#./:-]{1,256}$/;

export const DeletionRefusalCode = {
  MalformedEmail: 'malformed_email',
  DuplicateEntry: 'duplicate_entry',
  ProtectedStaffDomain: 'protected_staff_domain',
  ProtectedAdmin: 'protected_admin',
  ProtectedBot: 'protected_bot',
  ProtectedHostedDomain: 'protected_hosted_domain',
  ProtectedSelf: 'protected_self',
  MalformedTicket: 'malformed_ticket',
  AmbiguousCloudIdentity: 'ambiguous_cloud_identity',
  UserHintMismatch: 'user_hint_mismatch',
  AlreadyActive: 'already_active',
  TicketUnresolved: 'ticket_unresolved',
  TicketAlreadyActive: 'ticket_already_active',
  NoCloudUser: 'no_cloud_user',
} as const;

export type DeletionRefusalCode = (typeof DeletionRefusalCode)[keyof typeof DeletionRefusalCode];

export type ProtectedIdentityTarget = {
  id: string;
  is_admin: boolean;
  is_super_admin: boolean;
  is_bot: boolean;
  hosted_domain: string | null;
  google_user_email: string;
};

export type DeletionActorIdentity = {
  id: string | null;
  email: string | null;
};

export type DeletionPreviewEntry = {
  email?: string;
  pylonTicket?: string;
};

export type DeletionPreviewAccepted = {
  ok: true;
  email: string;
  pylonTicket: string | null;
};

export type DeletionPreviewRejected = {
  ok: false;
  email: string;
  pylonTicket: string | null;
  code: DeletionRefusalCode;
};

export type DeletionPreviewResult = {
  accepted: DeletionPreviewAccepted[];
  rejected: DeletionPreviewRejected[];
};

const EmailSchema = z.string().trim().toLowerCase().email().max(320);

export function normalizeDeletionEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function deletionEmailsEqual(a: string, b: string): boolean {
  return normalizeDeletionEmail(a) === normalizeDeletionEmail(b);
}

export function emailDomainAfterLastAt(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) return '';
  return email.slice(at + 1).toLowerCase();
}

export function isKiloOwnedEmailDomain(domain: string): boolean {
  return KILO_OWNED_DOMAINS.some(owned => domain === owned || domain.endsWith(`.${owned}`));
}

export function parsePylonTicket(
  value: string | undefined
): string | null | typeof DeletionRefusalCode.MalformedTicket {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!PYLON_TICKET_RE.test(trimmed)) {
    return DeletionRefusalCode.MalformedTicket;
  }
  return trimmed;
}

export function classifyProtectedIdentity(params: {
  email: string;
  user?: ProtectedIdentityTarget | null;
  actor?: DeletionActorIdentity | null;
}): DeletionRefusalCode | null {
  if (isSelfDeletionTarget(params)) {
    return DeletionRefusalCode.ProtectedSelf;
  }
  if (params.user?.is_bot) {
    return DeletionRefusalCode.ProtectedBot;
  }
  return null;
}

function isSelfDeletionTarget(params: {
  email: string;
  user?: ProtectedIdentityTarget | null;
  actor?: DeletionActorIdentity | null;
}): boolean {
  const actor = params.actor;
  if (!actor) return false;
  if (actor.id && params.user?.id && actor.id === params.user.id) {
    return true;
  }
  if (actor.email && deletionEmailsEqual(actor.email, params.email)) {
    return true;
  }
  return false;
}

export function previewDeletionTargets(entries: DeletionPreviewEntry[]): DeletionPreviewResult {
  const accepted: DeletionPreviewAccepted[] = [];
  const rejected: DeletionPreviewRejected[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const rawEmail = entry.email?.trim() ?? '';
    const parsedEmail = rawEmail ? EmailSchema.safeParse(entry.email) : null;
    const ticket = parsePylonTicket(entry.pylonTicket);
    if (!parsedEmail?.success) {
      if (!rawEmail && ticket && ticket !== DeletionRefusalCode.MalformedTicket) {
        const ticketKey = `ticket:${ticket.replace(/^#/, '')}`;
        if (seen.has(ticketKey)) {
          rejected.push({
            ok: false,
            email: '',
            pylonTicket: ticket,
            code: DeletionRefusalCode.DuplicateEntry,
          });
          continue;
        }
        seen.add(ticketKey);
        accepted.push({ ok: true, email: '', pylonTicket: ticket });
        continue;
      }
      rejected.push({
        ok: false,
        email: rawEmail,
        pylonTicket: entry.pylonTicket?.trim() || null,
        code: rawEmail
          ? DeletionRefusalCode.MalformedEmail
          : ticket === DeletionRefusalCode.MalformedTicket
            ? DeletionRefusalCode.MalformedTicket
            : DeletionRefusalCode.MalformedEmail,
      });
      continue;
    }
    if (ticket === DeletionRefusalCode.MalformedTicket) {
      rejected.push({
        ok: false,
        email: parsedEmail.data,
        pylonTicket: entry.pylonTicket?.trim() || null,
        code: DeletionRefusalCode.MalformedTicket,
      });
      continue;
    }
    if (seen.has(parsedEmail.data)) {
      rejected.push({
        ok: false,
        email: parsedEmail.data,
        pylonTicket: ticket,
        code: DeletionRefusalCode.DuplicateEntry,
      });
      continue;
    }
    if (ticket) {
      const ticketKey = `ticket:${ticket.replace(/^#/, '')}`;
      if (seen.has(ticketKey)) {
        rejected.push({
          ok: false,
          email: parsedEmail.data,
          pylonTicket: ticket,
          code: DeletionRefusalCode.DuplicateEntry,
        });
        continue;
      }
      seen.add(ticketKey);
    }
    seen.add(parsedEmail.data);
    accepted.push({
      ok: true,
      email: parsedEmail.data,
      pylonTicket: ticket,
    });
  }

  return { accepted, rejected };
}
