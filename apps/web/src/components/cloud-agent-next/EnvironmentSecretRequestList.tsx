'use client';

import { useId } from 'react';
import { TriangleAlert } from 'lucide-react';
import type {
  EnvironmentSecretChange,
  EnvironmentSetupSecretRequest,
} from '@kilocode/cloud-agent-profile';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { parseEnvironmentVariables } from './environment-variables';

type SecretReference = EnvironmentSetupSecretRequest['references'][number];

export function variablesTextWithPendingKeys(
  variablesText: string,
  keys: readonly string[]
): string {
  const present = new Set(parseEnvironmentVariables(variablesText).map(variable => variable.key));
  const missing = [...new Set(keys)].filter(key => !present.has(key));
  if (missing.length === 0) return variablesText;
  const separator = variablesText === '' || variablesText.endsWith('\n') ? '' : '\n';
  return `${variablesText}${separator}${missing.map(key => `${key}=`).join('\n')}`;
}

export function pendingSecretSave(
  secrets: readonly EnvironmentSecretChange[],
  pendingKeys: readonly string[],
  skipped: ReadonlySet<string>
): { secrets: EnvironmentSecretChange[]; error: string | null } {
  const empty = pendingKeys.filter(
    key =>
      !skipped.has(key) &&
      secrets.some(change => change.key === key && 'value' in change && change.value === '')
  );
  if (empty.length > 0) {
    return {
      secrets: [],
      error:
        empty.length === 1
          ? `Enter a value for ${empty[0]} or skip it.`
          : `Enter a value for ${empty.join(', ')} or skip them.`,
    };
  }
  return { secrets: secrets.filter(change => !skipped.has(change.key)), error: null };
}

export function secretReferenceUrl(reference: SecretReference, ref: string): string {
  return `https://github.com/${reference.repoFullName}/blob/${ref}/${reference.path}#L${reference.line}`;
}

type EnvironmentSecretRequestListProps = {
  requests: readonly EnvironmentSetupSecretRequest[];
  environmentName: string;
  organizationName?: string;
  skipped: ReadonlySet<string>;
  onSkipChange: (key: string, skipped: boolean) => void;
  referenceRef?: string | null;
};

export function EnvironmentSecretRequestList({
  requests,
  environmentName,
  organizationName,
  skipped,
  onSkipChange,
  referenceRef,
}: EnvironmentSecretRequestListProps) {
  const idPrefix = useId();
  const pending = requests.filter(request => request.state === 'pending');
  if (pending.length === 0) return null;
  const ref = referenceRef ?? 'HEAD';
  const scope = organizationName
    ? `Stored encrypted in ${environmentName}. Every session that uses this environment can read it, including other members' sessions in ${organizationName}. Values are never shown again after saving.`
    : `Stored encrypted in ${environmentName}. Every session that uses this environment can read it. Values are never shown again after saving.`;

  return (
    <div className="bg-muted/30 rounded-md border px-3 py-3">
      <p className="text-muted-foreground text-xs leading-5">{scope}</p>
      <ul className="mt-3 space-y-4">
        {pending.map(request => {
          const checkboxId = `${idPrefix}-${request.key}`;
          return (
            <li key={request.key} className="space-y-1.5">
              <div className="flex items-start justify-between gap-3">
                <code className="font-mono text-sm break-all">{request.key}</code>
                <div className="flex shrink-0 items-center gap-1.5 pointer-coarse:min-h-11">
                  <Checkbox
                    id={checkboxId}
                    checked={skipped.has(request.key)}
                    onCheckedChange={checked => onSkipChange(request.key, checked === true)}
                  />
                  <Label htmlFor={checkboxId} className="text-xs">
                    Skip
                  </Label>
                </div>
              </div>
              <p className="text-xs leading-5">
                <span className="font-medium">Reason given by the agent:</span>{' '}
                <span className="break-words whitespace-pre-wrap">{request.reason}</span>
              </p>
              {request.references.length > 0 && (
                <ul className="space-y-1">
                  {request.references.map(reference => (
                    <li
                      key={`${reference.repoFullName}:${reference.path}:${reference.line}`}
                      className="text-xs"
                    >
                      <a
                        href={secretReferenceUrl(reference, ref)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-link underline underline-offset-2"
                      >
                        {reference.path}:{reference.line}
                      </a>
                      {reference.verified === false && (
                        <span className="text-muted-foreground">
                          {' '}
                          · Not found in the repository
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {request.highPrivilege && (
                <p className="text-status-warning flex items-start gap-1.5 text-xs leading-5">
                  <TriangleAlert
                    className="text-status-warning-icon mt-px size-3.5 shrink-0"
                    aria-hidden
                  />
                  This name usually grants broad access. Prefer a test or restricted key.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
