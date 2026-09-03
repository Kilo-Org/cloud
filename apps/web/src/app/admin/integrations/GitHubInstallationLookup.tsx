'use client';

import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { GitHubOrganizationInstallationLookupResult } from '@/lib/admin/github-installation-lookup';
import { normalizeGitHubOrganizationLogin } from '@/lib/admin/github-installation-lookup-input';
import { useTRPC } from '@/lib/trpc/utils';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

export function GitHubInstallationLookup() {
  const trpc = useTRPC();
  const [organization, setOrganization] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const lookup = useMutation(
    trpc.admin.github.lookupOrganizationInstallation.mutationOptions({ retry: false })
  );
  const result = inputError || lookup.isPending || lookup.isError ? undefined : lookup.data;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      const normalizedOrganization = normalizeGitHubOrganizationLogin(organization);
      setInputError(null);
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
                disabled={lookup.isPending}
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
            <Button type="submit" className="sm:min-w-32" disabled={lookup.isPending}>
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
        </CardContent>
      </Card>

      {result ? <GitHubInstallationLookupResult result={result} /> : null}
    </div>
  );
}

export function GitHubInstallationLookupResult({ result }: { result: LookupResult }) {
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
        <LocalAssociationTable records={result.records} />
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

export function LocalAssociationTable({ records }: { records: LookupRecord[] }) {
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground h-24 text-center">
                No local association records matched this lookup.
              </TableCell>
            </TableRow>
          ) : (
            records.map(record => <LocalAssociationRow key={record.id} record={record} />)
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function LocalAssociationRow({ record }: { record: LookupRecord }) {
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
    </TableRow>
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
