import { SUPPORT_WRITE_REQUEST_TTL_SECONDS } from '@kilocode/web-shared/lib/admin/support-access';

export type SupportRequestOutcome =
  | {
      kind: 'read-active';
      organizationId: string;
      organizationName: string;
      href: string;
      message: string;
    }
  | {
      kind: 'notice';
      organizationId: string;
      organizationName: string;
      message: string;
    };

export function supportRequestOutcome(params: {
  actionClass: 'support_read' | 'support_write';
  status: string;
  organizationId: string;
  organizationName: string | null;
}): SupportRequestOutcome {
  const organizationName = params.organizationName ?? 'the organization';
  const href = `/organizations/${params.organizationId}`;
  if (params.actionClass === 'support_read') {
    if (params.status !== 'active') {
      return {
        kind: 'notice',
        organizationId: params.organizationId,
        organizationName,
        message: `Read access to ${organizationName} was requested but is not active. Check My open grants for its status.`,
      };
    }
    return {
      kind: 'read-active',
      organizationId: params.organizationId,
      organizationName,
      href,
      message: `Read access to ${organizationName} is active.`,
    };
  }
  return {
    kind: 'notice',
    organizationId: params.organizationId,
    organizationName,
    message: `Write access request for ${organizationName} is waiting for a second admin's approval. The request stays open for ${SUPPORT_WRITE_REQUEST_TTL_SECONDS / 60} minutes.`,
  };
}

export function SupportRequestOutcomeNotice({ outcome }: { outcome: SupportRequestOutcome }) {
  return (
    <div
      role="status"
      className="border-border bg-muted/40 flex flex-col gap-1 rounded-md border px-3 py-2 text-sm"
    >
      <p>{outcome.message}</p>
      {outcome.kind === 'read-active' && (
        <a
          href={outcome.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary self-start font-medium hover:underline"
        >
          Open organization
        </a>
      )}
    </div>
  );
}
