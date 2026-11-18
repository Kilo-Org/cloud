'use client';

import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { secretReferenceUrl } from './environment-setup-secrets';

export function EnvironmentSecretRequestList({
  run,
  organizationId,
  skipped,
  onSkippedChange,
  disabled,
}: {
  run: SetupRunResponse;
  organizationId?: string;
  skipped: string[];
  onSkippedChange: (keys: string[]) => void;
  disabled: boolean;
}) {
  const organization = useOrganizationWithMembers(organizationId ?? '', {
    enabled: !!organizationId,
  });
  const requests = run.secretRequests.filter(request => request.state === 'pending');
  if (!requests.length) return null;
  return (
    <section className="space-y-3">
      <p className="text-muted-foreground text-xs leading-5">
        Stored encrypted in {run.environmentName ?? 'this environment'}. Every session that uses
        this environment can read it
        {organizationId
          ? `, including other members' sessions in ${organization.data?.name ?? 'this organization'}`
          : ''}
        . Values are never shown again after saving.
      </p>
      <ul className="divide-y rounded-md border px-3">
        {requests.map(request => (
          <li key={request.key} className="space-y-2 py-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <code className="min-w-0 break-all font-medium">{request.key}</code>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 py-1 pointer-coarse:min-h-11">
                <input
                  type="checkbox"
                  checked={skipped.includes(request.key)}
                  disabled={disabled}
                  onChange={event =>
                    onSkippedChange(
                      event.target.checked
                        ? [...skipped, request.key]
                        : skipped.filter(key => key !== request.key)
                    )
                  }
                  className="accent-primary size-4"
                />
                Skip
              </label>
            </div>
            <p className="break-words whitespace-pre-wrap">
              <span className="text-muted-foreground">Reason given by the agent: </span>
              {request.reason}
            </p>
            {request.references.length > 0 && (
              <ul className="space-y-1">
                {request.references.map((reference, index) => (
                  <li
                    key={`${reference.repoFullName}:${reference.path}:${reference.line}:${index}`}
                    className="break-words"
                  >
                    <a
                      href={secretReferenceUrl(reference)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-link underline"
                    >
                      {reference.repoFullName}/{reference.path}:{reference.line}
                    </a>
                    {reference.verified === false && (
                      <span className="text-muted-foreground block">
                        Not found in the repository
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {request.highPrivilege && (
              <p className="text-status-warning">
                This name usually grants broad access. Prefer a test or restricted key.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
