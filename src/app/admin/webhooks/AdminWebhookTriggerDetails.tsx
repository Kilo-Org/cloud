'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Webhook, ExternalLink, ShieldCheck } from 'lucide-react';
import { WebhookRequestsContent } from '@/app/(app)/cloud/webhooks/[triggerId]/requests/WebhookRequestsContent';

type AdminWebhookTriggerDetailsProps = {
  params: Promise<{ id: string; triggerId: string }>;
  scope: 'user' | 'organization';
};

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

export function AdminWebhookTriggerDetails({ params, scope }: AdminWebhookTriggerDetailsProps) {
  const { id, triggerId } = use(params);
  const trpc = useTRPC();

  const ownerId = decodeURIComponent(id);
  const isOrg = scope === 'organization';
  const listPath = isOrg
    ? `/admin/organizations/${encodeURIComponent(ownerId)}/webhooks`
    : `/admin/users/${encodeURIComponent(ownerId)}/webhooks`;
  const parentPath = isOrg
    ? `/admin/organizations/${encodeURIComponent(ownerId)}`
    : `/admin/users/${encodeURIComponent(ownerId)}`;

  const triggerInput = isOrg
    ? ({ scope: 'organization', organizationId: ownerId, triggerId } as const)
    : ({ scope: 'user', userId: ownerId, triggerId } as const);

  const { data, isLoading, error, refetch } = useQuery(
    trpc.admin.webhookTriggers.get.queryOptions(triggerInput)
  );

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href={parentPath}>{isOrg ? 'Organization' : 'User'}</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbLink href={listPath}>Webhook Triggers</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{triggerId}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  if (isLoading) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-9 w-64" />
          </div>
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-64" />
            </CardHeader>
            <CardContent className="space-y-4">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-6 w-72" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        </div>
      </AdminPage>
    );
  }

  if (error || !data) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <Card>
          <CardHeader>
            <CardTitle>Unable to load trigger</CardTitle>
            <CardDescription>{error?.message ?? 'Trigger not found'}</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href={listPath}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Webhooks
              </Link>
            </Button>
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </AdminPage>
    );
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-6">
        <div>
          <Button variant="ghost" size="sm" asChild>
            <Link href={listPath}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Webhook Triggers
            </Link>
          </Button>
          <div className="mt-4 flex items-center gap-3">
            <ShieldCheck className="h-8 w-8" />
            <h1 className="text-3xl font-bold">Trigger: {triggerId}</h1>
          </div>
          <p className="text-muted-foreground mt-2">Read-only configuration and request history.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="h-5 w-5" />
              Configuration
            </CardTitle>
            <CardDescription>Worker-backed configuration snapshot.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-muted-foreground text-sm">Inbound URL</p>
              <div className="flex items-center gap-2">
                <code className="bg-muted flex-1 truncate rounded-md border px-2 py-1 text-xs">
                  {data.inboundUrl}
                </code>
              </div>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Status</p>
              <Badge variant={data.isActive ? 'default' : 'secondary'}>
                {data.isActive ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">GitHub Repo</p>
              <p className="font-mono text-sm break-all">{data.githubRepo}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Profile ID</p>
              <p className="font-mono text-sm break-all">{data.profileId ?? '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Mode</p>
              <p className="text-sm">{data.mode}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Model</p>
              <p className="font-mono text-sm break-all">{data.model}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Created</p>
              <p className="text-sm">{formatTimestamp(data.createdAt)}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Webhook Auth</p>
              <p className="text-sm">
                {data.webhookAuthConfigured
                  ? `Enabled (${data.webhookAuthHeader ?? 'header set'})`
                  : 'Disabled'}
              </p>
            </div>
            <div className="md:col-span-2">
              <p className="text-muted-foreground text-sm">Prompt Template</p>
              <pre className="bg-muted mt-2 max-h-64 overflow-auto rounded-md border p-3 text-xs">
                <code>{data.promptTemplate}</code>
              </pre>
            </div>
            <div className="flex flex-wrap gap-4 md:col-span-2">
              <div>
                <p className="text-muted-foreground text-sm">Auto Commit</p>
                <p className="text-sm">{data.autoCommit ? 'Enabled' : 'Disabled'}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-sm">Condense on Complete</p>
                <p className="text-sm">{data.condenseOnComplete ? 'Enabled' : 'Disabled'}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xl font-semibold">Captured Requests</h2>
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/session-traces">
                <ExternalLink className="mr-2 h-4 w-4" />
                Open Session Traces
              </Link>
            </Button>
          </div>
          <WebhookRequestsContent
            params={params}
            organizationId={isOrg ? ownerId : undefined}
            adminPathBase={listPath}
            adminUserId={isOrg ? undefined : ownerId}
          />
        </div>
      </div>
    </AdminPage>
  );
}
