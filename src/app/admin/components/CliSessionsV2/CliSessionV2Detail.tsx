'use client';

import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAdminCliSessionV2 } from '@/app/admin/api/cli-sessions-v2/hooks';
import {
  User,
  Building2,
  Calendar,
  Monitor,
  ExternalLink,
  Loader2,
  GitBranch,
} from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return 'Never';
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

function formatAbsoluteTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

type CliSessionV2DetailPageProps = {
  children: React.ReactNode;
  sessionTitle: string | undefined;
};

function CliSessionV2DetailPage({ children, sessionTitle }: CliSessionV2DetailPageProps) {
  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/cli-sessions-v2">CLI Sessions V2</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{sessionTitle ?? 'Session Details'}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return <AdminPage breadcrumbs={breadcrumbs}>{children}</AdminPage>;
}

export function CliSessionV2Detail({
  sessionId,
  kiloUserId,
}: {
  sessionId: string;
  kiloUserId: string;
}) {
  const { data: session, isLoading, error } = useAdminCliSessionV2(sessionId, kiloUserId);

  if (isLoading) {
    return (
      <CliSessionV2DetailPage sessionTitle={undefined}>
        <div className="flex items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading session details...</span>
        </div>
      </CliSessionV2DetailPage>
    );
  }

  if (error) {
    return (
      <CliSessionV2DetailPage sessionTitle={undefined}>
        <Alert variant="destructive">
          <AlertDescription>
            {error instanceof Error ? error.message : 'Failed to load session'}
          </AlertDescription>
        </Alert>
      </CliSessionV2DetailPage>
    );
  }

  if (!session) {
    return (
      <CliSessionV2DetailPage sessionTitle={undefined}>
        <Alert variant="destructive">
          <AlertDescription>Session not found</AlertDescription>
        </Alert>
      </CliSessionV2DetailPage>
    );
  }

  return (
    <CliSessionV2DetailPage sessionTitle={session.title ?? session.session_id}>
      <div className="flex w-full flex-col gap-6">
        {/* Basic Information Card */}
        <Card>
          <CardHeader>
            <CardTitle>Session Information</CardTitle>
            <CardDescription>Basic details about this CLI session</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {/* Title */}
            <div className="md:col-span-2">
              <div className="text-muted-foreground text-sm font-medium">Title</div>
              <div className="text-lg font-semibold break-words">
                {session.title || 'Untitled'}
              </div>
            </div>

            {/* Platform */}
            <div className="flex items-center gap-2">
              <Monitor className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Platform</div>
                <Badge variant="secondary">{session.created_on_platform}</Badge>
              </div>
            </div>

            {/* Version */}
            <div>
              <div className="text-muted-foreground text-xs">Version</div>
              <div className="text-sm">{session.version}</div>
            </div>

            {/* Owner */}
            <div className="flex items-center gap-2">
              <User className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">User</div>
                <Link
                  href={`/admin/users/${encodeURIComponent(session.kilo_user_id)}`}
                  className="text-sm text-blue-600 hover:underline"
                >
                  {session.owner_email ?? session.kilo_user_id}
                </Link>
              </div>
            </div>

            {/* Organization */}
            <div className="flex items-center gap-2">
              <Building2 className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Organization</div>
                {session.organization_id ? (
                  <Link
                    href={`/admin/organizations/${session.organization_id}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {session.org_name ?? session.organization_id}
                  </Link>
                ) : (
                  <span className="text-muted-foreground text-sm">None</span>
                )}
              </div>
            </div>

            {/* Created At */}
            <div className="flex items-center gap-2">
              <Calendar className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Created</div>
                <div className="text-sm" title={formatAbsoluteTime(session.created_at)}>
                  {formatRelativeTime(session.created_at)}
                </div>
              </div>
            </div>

            {/* Updated At */}
            <div className="flex items-center gap-2">
              <Calendar className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Updated</div>
                <div className="text-sm" title={formatAbsoluteTime(session.updated_at)}>
                  {formatRelativeTime(session.updated_at)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Git Information Card */}
        <Card>
          <CardHeader>
            <CardTitle>Git Information</CardTitle>
            <CardDescription>Repository and branch details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <GitBranch className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-sm font-medium">Repository URL</div>
                {session.git_url ? (
                  <code className="bg-muted rounded px-2 py-1 text-sm">{session.git_url}</code>
                ) : (
                  <span className="text-muted-foreground text-sm">No repository</span>
                )}
              </div>
            </div>

            <div>
              <div className="text-muted-foreground text-sm font-medium">Branch</div>
              {session.git_branch ? (
                <code className="bg-muted rounded px-2 py-1 text-sm">{session.git_branch}</code>
              ) : (
                <span className="text-muted-foreground text-sm">No branch</span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Session Links Card */}
        <Card>
          <CardHeader>
            <CardTitle>Related Sessions</CardTitle>
            <CardDescription>Cloud Agent and parent session links</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Cloud Agent Session */}
            <div>
              <div className="text-muted-foreground text-sm font-medium">
                Cloud Agent Session ID
              </div>
              {session.cloud_agent_session_id ? (
                <div className="flex items-center gap-3">
                  <code className="bg-muted rounded px-2 py-1 text-sm">
                    {session.cloud_agent_session_id}
                  </code>
                  <Link
                    href={`/admin/session-traces?sessionId=${session.cloud_agent_session_id}`}
                  >
                    <Button variant="outline" size="sm">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      View Session Traces
                    </Button>
                  </Link>
                </div>
              ) : (
                <span className="text-muted-foreground text-sm">No cloud agent session</span>
              )}
            </div>

            {/* Parent Session */}
            <div>
              <div className="text-muted-foreground text-sm font-medium">Parent Session ID</div>
              {session.parent_session_id ? (
                <div className="flex items-center gap-3">
                  <code className="bg-muted rounded px-2 py-1 text-sm">
                    {session.parent_session_id}
                  </code>
                  <Link
                    href={`/admin/cli-sessions-v2/${encodeURIComponent(session.parent_session_id)}?userId=${encodeURIComponent(session.kilo_user_id)}`}
                  >
                    <Button variant="outline" size="sm">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      View Parent Session
                    </Button>
                  </Link>
                </div>
              ) : (
                <span className="text-muted-foreground text-sm">No parent session</span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Technical Details Card */}
        <Card>
          <CardHeader>
            <CardTitle>Technical Details</CardTitle>
            <CardDescription>Internal identifiers and metadata</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-muted-foreground text-xs">Session ID</div>
              <code className="text-sm break-all">{session.session_id}</code>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Kilo User ID</div>
              <Link
                href={`/admin/users/${encodeURIComponent(session.kilo_user_id)}`}
                className="text-sm text-blue-600 hover:underline"
              >
                {session.kilo_user_id}
              </Link>
            </div>
            {session.public_id && (
              <div>
                <div className="text-muted-foreground text-xs">Public ID</div>
                <code className="text-sm">{session.public_id}</code>
              </div>
            )}
            <div>
              <div className="text-muted-foreground text-xs">Created At</div>
              <div className="text-sm">{formatAbsoluteTime(session.created_at)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Updated At</div>
              <div className="text-sm">{formatAbsoluteTime(session.updated_at)}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </CliSessionV2DetailPage>
  );
}
