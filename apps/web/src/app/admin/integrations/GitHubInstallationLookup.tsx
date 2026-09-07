'use client';

import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { GitHubOrganizationInstallationLookupResult } from '@/lib/admin/github-installation-lookup';
import { normalizeGitHubOrganizationLogin } from '@/lib/admin/github-installation-lookup-input';
import { GitHubInstallationUninstallInputSchema } from '@/lib/admin/github-installation-uninstall-input';
import { useTRPC } from '@/lib/trpc/utils';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type LookupResult = GitHubOrganizationInstallationLookupResult;
type LookupApp = LookupResult['apps'][number];
type LookupRecord = LookupResult['records'][number];
export type UninstallTarget = {
  integrationId: string;
  installationId: string;
  accountId: string;
  appType: 'standard' | 'lite';
  owner: NonNullable<LookupRecord['owner']>;
  accountLogin: string;
};

export const uninstallConfirmationCopy = {
  description:
    'This removes the GitHub App installation from GitHub. It cannot be undone from Kilo.',
  impact:
    'All repositories served by this GitHub installation lose app access. Kilo history and settings are retained. Reinstall the app through GitHub to restore access.',
};

function isPositiveDecimalString(value: string | null): value is string {
  return value !== null && /^[1-9]\d*$/.test(value);
}

export function getUninstallTarget(
  result: LookupResult,
  record: LookupRecord
): UninstallTarget | null {
  if (
    record.association !== 'actual' ||
    !record.owner ||
    !isPositiveDecimalString(record.installationId) ||
    !isPositiveDecimalString(record.accountId)
  ) {
    return null;
  }

  const appType = record.appType ?? 'standard';
  if (appType !== 'standard' && appType !== 'lite') return null;
  if (
    result.records.filter(
      candidate =>
        (candidate.appType ?? 'standard') === appType &&
        candidate.installationId === record.installationId
    ).length !== 1
  ) {
    return null;
  }

  const installation = result.apps.find(
    app =>
      app.appType === appType &&
      app.status === 'installed' &&
      app.installation?.id === record.installationId &&
      app.installation.accountId === record.accountId
  )?.installation;

  if (!installation) return null;

  const target: UninstallTarget = {
    integrationId: record.id,
    installationId: record.installationId,
    accountId: record.accountId,
    appType,
    owner: record.owner,
    accountLogin: installation.accountLogin,
  };

  return GitHubInstallationUninstallInputSchema.safeParse({
    ...target,
    owner: { type: target.owner.type, id: target.owner.id },
    confirmation: target.installationId,
  }).success
    ? target
    : null;
}

export function GitHubInstallationLookup() {
  const trpc = useTRPC();
  const [organization, setOrganization] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResult>();
  const [submittedOrganization, setSubmittedOrganization] = useState<string>();
  const [uninstallTarget, setUninstallTarget] = useState<UninstallTarget | null>(null);
  const [uninstallConfirmation, setUninstallConfirmation] = useState('');
  const [uninstallSuccess, setUninstallSuccess] = useState<string | null>(null);
  const [uninstalledIntegrationId, setUninstalledIntegrationId] = useState<string | null>(null);
  const [refreshingAfterUninstall, setRefreshingAfterUninstall] = useState(false);
  const lookup = useMutation(
    trpc.admin.github.lookupOrganizationInstallation.mutationOptions({
      retry: false,
      onSuccess: data => {
        setResult(data);
        setRefreshingAfterUninstall(false);
      },
      onError: () => {
        setResult(undefined);
        if (refreshingAfterUninstall) {
          setUninstallSuccess(
            previous =>
              `${previous ?? 'GitHub uninstall confirmed.'} The refreshed lookup could not be loaded. Refresh before taking another action.`
          );
          setRefreshingAfterUninstall(false);
        }
      },
    })
  );
  const uninstall = useMutation(
    trpc.admin.github.uninstallOrganizationInstallation.mutationOptions({
      retry: false,
      onSuccess: response => {
        const organizationToRefresh = submittedOrganization;
        setUninstallTarget(null);
        setUninstallConfirmation('');
        setResult(undefined);
        setUninstalledIntegrationId(uninstallTarget?.integrationId ?? null);
        setUninstallSuccess(
          response.localCleanup === 'pending'
            ? 'GitHub App was uninstalled, but local cleanup is not confirmed. The deletion webhook normally reconciles this. Refresh the lookup; manual investigation is needed if the record remains.'
            : 'GitHub App was uninstalled and local cleanup completed.'
        );
        if (organizationToRefresh) {
          setRefreshingAfterUninstall(true);
          lookup.mutate({ organization: organizationToRefresh });
        }
      },
      onError: () => {
        setResult(undefined);
      },
    })
  );
  const lookupBlocked = uninstall.isPending;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lookup.isPending || uninstall.isPending) return;
    setResult(undefined);

    try {
      const normalizedOrganization = normalizeGitHubOrganizationLogin(organization);
      setInputError(null);
      setUninstallSuccess(null);
      setUninstallTarget(null);
      setUninstallConfirmation('');
      setUninstalledIntegrationId(null);
      setResult(undefined);
      setSubmittedOrganization(normalizedOrganization);
      lookup.mutate({ organization: normalizedOrganization });
    } catch {
      setInputError('Enter a valid GitHub organization login.');
    }
  }

  return (
    <div className="flex w-full max-w-7xl flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Integrations</h2>
        <p className="text-muted-foreground max-w-3xl">
          Check GitHub App installations for an organization and compare the live response with
          locally recorded associations.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>GitHub organization lookup</CardTitle>
          <CardDescription>
            Enter a GitHub organization login, @mention, or github.com organization URL. This check
            runs only when submitted.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={onSubmit}
            noValidate
          >
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="github-organization">GitHub organization</Label>
              <Input
                id="github-organization"
                name="github-organization"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={256}
                disabled={lookup.isPending || lookupBlocked}
                placeholder="acme-tools"
                value={organization}
                onChange={event => {
                  setOrganization(event.target.value);
                  if (inputError) setInputError(null);
                }}
                aria-describedby={inputError ? 'github-organization-error' : undefined}
                aria-invalid={inputError ? true : undefined}
              />
              {inputError ? (
                <p id="github-organization-error" className="text-destructive text-sm" role="alert">
                  {inputError}
                </p>
              ) : null}
            </div>
            <Button
              type="submit"
              className="sm:min-w-32"
              disabled={lookup.isPending || lookupBlocked}
            >
              {lookup.isPending ? 'Checking…' : 'Check installation'}
            </Button>
          </form>

          {lookup.isPending ? <p role="status">Checking GitHub and local associations…</p> : null}
          {lookup.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Lookup unavailable</AlertTitle>
              <AlertDescription>
                Unable to check this organization. Submit again to retry.
              </AlertDescription>
            </Alert>
          ) : null}
          {uninstallSuccess ? (
            <Alert>
              <AlertTitle>GitHub uninstall confirmed</AlertTitle>
              <AlertDescription>{uninstallSuccess}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {result ? (
        <GitHubInstallationLookupResult
          result={result}
          uninstallPending={uninstall.isPending}
          unavailableIntegrationId={uninstalledIntegrationId}
          onUninstall={target => {
            uninstall.reset();
            setUninstallConfirmation('');
            setUninstallTarget(target);
          }}
        />
      ) : null}
      <UninstallGitHubAppDialog
        target={uninstallTarget}
        confirmation={uninstallConfirmation}
        isPending={uninstall.isPending}
        error={
          uninstall.isError
            ? 'GitHub App uninstall could not be confirmed. Close this dialog and refresh the lookup before trying again.'
            : null
        }
        onConfirmationChange={setUninstallConfirmation}
        onOpenChange={open => {
          if (!open && !uninstall.isPending) {
            setUninstallTarget(null);
            setUninstallConfirmation('');
          }
        }}
        onConfirm={() => {
          if (
            uninstall.isPending ||
            uninstall.isError ||
            !uninstallTarget ||
            uninstallConfirmation !== uninstallTarget.installationId
          ) {
            return;
          }
          uninstall.mutate({
            integrationId: uninstallTarget.integrationId,
            installationId: uninstallTarget.installationId,
            accountId: uninstallTarget.accountId,
            appType: uninstallTarget.appType,
            owner: { type: uninstallTarget.owner.type, id: uninstallTarget.owner.id },
            confirmation: uninstallTarget.installationId,
          });
        }}
      />
    </div>
  );
}

export function GitHubInstallationLookupResult({
  result,
  onUninstall,
  uninstallPending = false,
  unavailableIntegrationId,
}: {
  result: LookupResult;
  onUninstall?: (target: UninstallTarget) => void;
  uninstallPending?: boolean;
  unavailableIntegrationId?: string | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section className="space-y-3" aria-labelledby="live-installations-heading">
        <div className="flex flex-col justify-between gap-1 sm:flex-row sm:items-baseline">
          <div>
            <h3 id="live-installations-heading" className="text-lg font-semibold">
              Live GitHub App checks
            </h3>
            <p className="text-muted-foreground text-sm">
              GitHub responses for <span className="font-mono">{result.organization}</span>. Checked{' '}
              {formatTimestamp(result.checkedAt)}.
            </p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {result.apps.map(app => (
            <LiveInstallationCard key={app.appType} app={app} />
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="local-records-heading">
        <div className="space-y-1">
          <h3 id="local-records-heading" className="text-lg font-semibold">
            Local recorded associations
          </h3>
          <p className="text-muted-foreground max-w-4xl text-sm">
            Actual matches share the live installation’s app type, installation ID and account ID.
            Candidates match a recorded login or ID but are not confirmed live associations. Records
            may be stale, and deleted installations are not retained. No local record does not mean
            the app is uninstalled.
          </p>
        </div>
        {result.recordsTruncated ? (
          <Alert variant="warning">
            <AlertTitle>Results truncated</AlertTitle>
            <AlertDescription>
              Only the first 100 local association records are shown.
            </AlertDescription>
          </Alert>
        ) : null}
        <LocalAssociationTable
          result={result}
          records={result.records}
          onUninstall={onUninstall}
          uninstallPending={uninstallPending}
          unavailableIntegrationId={unavailableIntegrationId}
        />
      </section>
    </div>
  );
}

function LiveInstallationCard({ app }: { app: LookupApp }) {
  const installation = app.installation;
  const status = liveStatus(app);

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="capitalize">{app.appType} app</CardTitle>
          <StatusBadge status={status} />
        </div>
        <CardDescription>{liveDetail(app)}</CardDescription>
      </CardHeader>
      {installation ? (
        <CardContent>
          <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label="Installation ID" value={installation.id} mono />
            <Detail label="Account" value={installation.accountLogin} />
            <Detail label="Account ID" value={installation.accountId} mono />
            <Detail label="Account type" value={installation.accountType} />
            <Detail label="Repository scope" value={installation.repositorySelection} />
            <Detail
              label="Suspended"
              value={installation.suspendedAt ? formatTimestamp(installation.suspendedAt) : 'No'}
            />
          </dl>
        </CardContent>
      ) : null}
    </Card>
  );
}

export function LocalAssociationTable({
  result,
  records,
  onUninstall,
  uninstallPending = false,
  unavailableIntegrationId,
}: {
  result?: LookupResult;
  records: LookupRecord[];
  onUninstall?: (target: UninstallTarget) => void;
  uninstallPending?: boolean;
  unavailableIntegrationId?: string | null;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Association</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>App and installation</TableHead>
            <TableHead>GitHub account</TableHead>
            <TableHead>Local state</TableHead>
            <TableHead>Updated</TableHead>
            {onUninstall ? <TableHead className="text-right">Action</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={onUninstall ? 7 : 6}
                className="text-muted-foreground h-24 text-center"
              >
                No local association records matched this lookup.
              </TableCell>
            </TableRow>
          ) : (
            records.map(record => (
              <LocalAssociationRow
                key={record.id}
                record={record}
                uninstallTarget={
                  result && record.id !== unavailableIntegrationId
                    ? getUninstallTarget(result, record)
                    : null
                }
                uninstallPending={uninstallPending}
                onUninstall={onUninstall}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function LocalAssociationRow({
  record,
  uninstallTarget,
  uninstallPending,
  onUninstall,
}: {
  record: LookupRecord;
  uninstallTarget: UninstallTarget | null;
  uninstallPending: boolean;
  onUninstall?: (target: UninstallTarget) => void;
}) {
  return (
    <TableRow>
      <TableCell className="min-w-36 align-top">
        <Badge variant={record.association === 'actual' ? 'new' : 'secondary'}>
          {record.association === 'actual' ? 'Actual match' : 'Candidate match'}
        </Badge>
        <div className="text-muted-foreground mt-2 font-mono text-xs break-all">{record.id}</div>
      </TableCell>
      <TableCell className="min-w-48 align-top text-sm">{renderOwner(record.owner)}</TableCell>
      <TableCell className="min-w-48 align-top text-sm">
        <div>{record.appType ?? 'App type not recorded'}</div>
        <div className="text-muted-foreground mt-1 font-mono text-xs">
          {record.installationId ?? 'Installation ID not recorded'}
        </div>
      </TableCell>
      <TableCell className="min-w-48 align-top text-sm">
        <div>{record.accountLogin ?? 'Account login not recorded'}</div>
        <div className="text-muted-foreground mt-1 font-mono text-xs">
          {record.accountId ?? 'Account ID not recorded'}
        </div>
      </TableCell>
      <TableCell className="min-w-52 align-top text-sm">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{record.status ?? 'Status not recorded'}</Badge>
          {record.authInvalid ? <Badge variant="destructive">Authentication invalid</Badge> : null}
          {record.suspendedAt ? <Badge variant="destructive">Suspended</Badge> : null}
        </div>
        {record.suspendedAt ? (
          <div className="text-muted-foreground mt-2 text-xs">
            Suspended {formatTimestamp(record.suspendedAt)}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground min-w-40 align-top text-sm">
        {formatTimestamp(record.updatedAt)}
      </TableCell>
      {onUninstall ? (
        <TableCell className="min-w-40 align-top text-right">
          {uninstallTarget ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={uninstallPending}
              onClick={() => onUninstall(uninstallTarget)}
            >
              Uninstall GitHub App
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">Not eligible</span>
          )}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

export function UninstallGitHubAppDialog({
  target,
  confirmation,
  isPending,
  error,
  onConfirmationChange,
  onOpenChange,
  onConfirm,
}: {
  target: UninstallTarget | null;
  confirmation: string;
  isPending: boolean;
  error: string | null;
  onConfirmationChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const canConfirm = target !== null && confirmation === target.installationId;

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="sm:max-w-xl"
        aria-busy={isPending}
        onEscapeKeyDown={event => {
          if (isPending) event.preventDefault();
        }}
        onPointerDownOutside={event => {
          if (isPending) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Uninstall GitHub App?</AlertDialogTitle>
          <AlertDialogDescription>{uninstallConfirmationCopy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {target ? (
          <div className="space-y-4 text-sm">
            <dl className="grid gap-x-4 gap-y-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
              <Detail label="GitHub App" value={`${target.appType} app`} />
              <Detail label="GitHub login" value={target.accountLogin} />
              <Detail label="Installation ID" value={target.installationId} mono />
              <Detail label="Kilo owner" value={`${target.owner.type}: ${target.owner.id}`} mono />
            </dl>
            <Alert variant="destructive">
              <AlertTitle>Repository access will stop</AlertTitle>
              <AlertDescription>{uninstallConfirmationCopy.impact}</AlertDescription>
            </Alert>
            <div className="flex flex-col gap-2">
              <Label htmlFor="github-installation-uninstall-confirmation">
                Type installation ID <span className="font-mono">{target.installationId}</span> to
                confirm
              </Label>
              <Input
                id="github-installation-uninstall-confirmation"
                value={confirmation}
                onChange={event => onConfirmationChange(event.target.value)}
                disabled={isPending}
                autoComplete="off"
                maxLength={16}
                inputMode="numeric"
                aria-describedby={error ? 'github-installation-uninstall-error' : undefined}
              />
            </div>
            {error ? (
              <p
                id="github-installation-uninstall-error"
                className="text-destructive text-sm"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isPending || error !== null || !canConfirm}
            onClick={onConfirm}
          >
            {isPending ? 'Uninstalling GitHub App…' : 'Uninstall GitHub App'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={mono ? 'mt-1 font-mono text-xs break-all' : 'mt-1 break-words'}>{value}</dd>
    </div>
  );
}

function renderOwner(owner: LookupRecord['owner']) {
  if (!owner) return <span className="text-muted-foreground">No owner linked</span>;

  const href =
    owner.type === 'user'
      ? `/admin/users/${encodeURIComponent(owner.id)}`
      : `/admin/organizations/${encodeURIComponent(owner.id)}`;
  const type = owner.type === 'user' ? 'Personal' : 'Organization';

  return (
    <div className="flex flex-col gap-1">
      <Badge variant="outline">{type}</Badge>
      <Link href={href} className="text-link hover:text-link-hover break-words">
        {owner.name ?? 'Unnamed owner'}
      </Link>
      <span className="text-muted-foreground font-mono text-xs break-all">{owner.id}</span>
    </div>
  );
}

function liveStatus(app: LookupApp) {
  if (app.reason === 'suspended') return 'suspended';
  return app.status;
}

function liveDetail(app: LookupApp) {
  if (app.reason === 'suspended') return 'GitHub reports this installation as suspended.';
  if (app.status === 'installed') return 'GitHub reports an active installation record.';
  if (app.status === 'not_found') {
    return 'GitHub returned no installation for this app and login. The organization may not exist or may have been renamed. This does not confirm an uninstall.';
  }
  switch (app.reason) {
    case 'app_not_configured':
      return 'This app is not configured in this environment. Its installation state is unknown.';
    case 'authentication_failed':
      return 'GitHub refused this app’s lookup. Its installation state is unknown.';
    case 'request_timeout':
      return 'GitHub did not respond in time. Submit again to retry.';
    default:
      return 'The live installation state could not be determined. Submit again to retry.';
  }
}

function StatusBadge({ status }: { status: 'installed' | 'suspended' | 'not_found' | 'unknown' }) {
  const labels = {
    installed: 'Installed',
    suspended: 'Suspended',
    not_found: 'No installation found',
    unknown: 'Unknown',
  };
  const variant =
    status === 'installed' ? 'new' : status === 'suspended' ? 'destructive' : 'secondary';

  return <Badge variant={variant}>{labels[status]}</Badge>;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
}
