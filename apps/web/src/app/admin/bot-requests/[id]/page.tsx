'use client';

import { useParams } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { format, parseISO } from 'date-fns';
import AdminPage from '../../components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import Link from 'next/link';
import { useBotRequestDetail } from '../hooks';
import { BotRequestStatusBadge } from '../BotRequestStatusBadge';

type StepData = {
  stepNumber: number;
  finishReason: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  toolResults?: Array<{ name: string; result?: unknown }>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-2">
      <span className="text-muted-foreground w-40 shrink-0 text-sm font-medium">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function StepsTable({ steps }: { steps: StepData[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Steps</CardTitle>
        <CardDescription>
          {steps.length} step{steps.length !== 1 ? 's' : ''} recorded
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead>Finish Reason</TableHead>
              <TableHead className="text-right">Input Tokens</TableHead>
              <TableHead className="text-right">Output Tokens</TableHead>
              <TableHead className="text-right">Total Tokens</TableHead>
              <TableHead>Tool Calls</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map(step => (
              <TableRow key={step.stepNumber}>
                <TableCell className="font-mono">{step.stepNumber}</TableCell>
                <TableCell>
                  <Badge variant="outline">{step.finishReason}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {step.usage?.inputTokens?.toLocaleString() ?? '-'}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {step.usage?.outputTokens?.toLocaleString() ?? '-'}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {step.usage?.totalTokens?.toLocaleString() ?? '-'}
                </TableCell>
                <TableCell className="text-sm">
                  {step.toolCalls && step.toolCalls.length > 0
                    ? step.toolCalls.map(tc => tc.name).join(', ')
                    : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function BotRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data, isLoading, error } = useBotRequestDetail(id);

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/bot-requests">Bot Requests</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{id.slice(0, 8)}...</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  if (error) {
    const isNotFound = error.data?.code === 'NOT_FOUND';

    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <Card>
          <CardHeader>
            <CardTitle>{isNotFound ? 'Bot Request Not Found' : 'Error'}</CardTitle>
            <CardDescription>
              {isNotFound
                ? 'The requested bot request does not exist or is no longer available.'
                : error.message}
            </CardDescription>
          </CardHeader>
        </Card>
      </AdminPage>
    );
  }

  if (isLoading) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Loading...</CardTitle>
              <CardDescription>Fetching bot request details</CardDescription>
            </CardHeader>
          </Card>
        </div>
      </AdminPage>
    );
  }

  if (!data) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <Card>
          <CardHeader>
            <CardTitle>Bot Request Not Found</CardTitle>
            <CardDescription>
              The requested bot request does not exist or is no longer available.
            </CardDescription>
          </CardHeader>
        </Card>
      </AdminPage>
    );
  }

  const totalTokens =
    data.steps?.reduce((sum, step) => sum + (step.usage?.totalTokens ?? 0), 0) ?? 0;

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-6">
        <h2 className="text-2xl font-bold">Bot Request Detail</h2>

        {/* Overview cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Status</CardTitle>
            </CardHeader>
            <CardContent>
              <BotRequestStatusBadge status={data.status} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Platform</CardTitle>
            </CardHeader>
            <CardContent>
              <Badge variant="outline">{data.platform}</Badge>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Response Time</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {data.responseTimeMs != null ? `${data.responseTimeMs.toLocaleString()}ms` : '-'}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {totalTokens > 0 ? totalTokens.toLocaleString() : '-'}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Request info */}
        <Card>
          <CardHeader>
            <CardTitle>Request Info</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <InfoRow label="Request ID">
              <code className="text-xs">{data.id}</code>
            </InfoRow>
            <InfoRow label="User">
              <Link
                href={`/admin/users/${encodeURIComponent(data.userId)}`}
                className="text-primary hover:underline"
              >
                {data.userEmail}
              </Link>{' '}
              <span className="text-muted-foreground">({data.userName})</span>
            </InfoRow>
            <InfoRow label="Organization">
              {data.organizationId ? (
                <Link
                  href={`/admin/organizations/${data.organizationId}`}
                  className="text-primary hover:underline"
                >
                  {data.organizationName ?? data.organizationId}
                </Link>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </InfoRow>
            <InfoRow label="Model">
              {data.modelUsed ?? <span className="text-muted-foreground">-</span>}
            </InfoRow>
            <InfoRow label="Thread ID">
              <code className="text-xs">{data.platformThreadId}</code>
            </InfoRow>
            {data.cloudAgentSessionId && (
              <InfoRow label="Cloud Agent Session">
                <code className="text-xs">{data.cloudAgentSessionId}</code>
              </InfoRow>
            )}
            <InfoRow label="Created">
              {format(parseISO(data.createdAt), 'MMM d, yyyy HH:mm:ss')}
            </InfoRow>
            <InfoRow label="Updated">
              {format(parseISO(data.updatedAt), 'MMM d, yyyy HH:mm:ss')}
            </InfoRow>
          </CardContent>
        </Card>

        {/* User message */}
        <Card>
          <CardHeader>
            <CardTitle>User Message</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted max-h-96 overflow-auto rounded-md p-4 text-sm whitespace-pre-wrap">
              {data.userMessage}
            </pre>
          </CardContent>
        </Card>

        {/* Error message */}
        {data.errorMessage && (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">Error Message</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="bg-destructive/10 max-h-64 overflow-auto rounded-md p-4 font-mono text-sm whitespace-pre-wrap">
                {data.errorMessage}
              </pre>
            </CardContent>
          </Card>
        )}

        {/* Steps */}
        {data.steps && data.steps.length > 0 && <StepsTable steps={data.steps} />}
      </div>
    </AdminPage>
  );
}
