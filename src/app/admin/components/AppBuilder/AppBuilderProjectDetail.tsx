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
import { useAdminAppBuilderProject } from '@/app/admin/api/app-builder/hooks';
import {
  User,
  Building2,
  Calendar,
  Clock,
  Cpu,
  ExternalLink,
  Loader2,
  FileCode,
  Rocket,
  Terminal,
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

type AppBuilderProjectDetailPageProps = {
  children: React.ReactNode;
  projectTitle: string | undefined;
};

function AppBuilderProjectDetailPage({ children, projectTitle }: AppBuilderProjectDetailPageProps) {
  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/app-builder">App Builder Projects</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{projectTitle ?? 'Project Details'}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return <AdminPage breadcrumbs={breadcrumbs}>{children}</AdminPage>;
}

export function AppBuilderProjectDetail({ projectId }: { projectId: string }) {
  const { data: project, isLoading, error } = useAdminAppBuilderProject(projectId);

  if (isLoading) {
    return (
      <AppBuilderProjectDetailPage projectTitle={undefined}>
        <div className="flex items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading project details...</span>
        </div>
      </AppBuilderProjectDetailPage>
    );
  }

  if (error) {
    return (
      <AppBuilderProjectDetailPage projectTitle={undefined}>
        <Alert variant="destructive">
          <AlertDescription>
            {error instanceof Error ? error.message : 'Failed to load project'}
          </AlertDescription>
        </Alert>
      </AppBuilderProjectDetailPage>
    );
  }

  if (!project) {
    return (
      <AppBuilderProjectDetailPage projectTitle={undefined}>
        <Alert variant="destructive">
          <AlertDescription>Project not found</AlertDescription>
        </Alert>
      </AppBuilderProjectDetailPage>
    );
  }

  return (
    <AppBuilderProjectDetailPage projectTitle={project.title}>
      <div className="flex w-full flex-col gap-6">
        {/* Basic Information Card */}
        <Card>
          <CardHeader>
            <CardTitle>Project Information</CardTitle>
            <CardDescription>Basic details about this App Builder project</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {/* Title */}
            <div className="md:col-span-2">
              <div className="text-muted-foreground text-sm font-medium">Title</div>
              <div className="text-lg font-semibold break-words">{project.title}</div>
            </div>

            {/* Model */}
            <div className="flex items-center gap-2">
              <Cpu className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Model</div>
                <div className="font-mono text-sm">{project.model_id}</div>
              </div>
            </div>

            {/* Template */}
            <div className="flex items-center gap-2">
              <FileCode className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Template</div>
                <div className="text-sm">{project.template ?? 'nextjs-starter (default)'}</div>
              </div>
            </div>

            {/* Owner */}
            <div className="flex items-center gap-2">
              {project.owned_by_user_id ? (
                <User className="text-muted-foreground h-4 w-4" />
              ) : (
                <Building2 className="text-muted-foreground h-4 w-4" />
              )}
              <div>
                <div className="text-muted-foreground text-xs">Owner</div>
                {project.owned_by_user_id ? (
                  <Link
                    href={`/admin/users/${encodeURIComponent(project.owned_by_user_id)}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {project.owner_email ?? project.owned_by_user_id}
                  </Link>
                ) : project.owned_by_organization_id ? (
                  <Link
                    href={`/admin/organizations/${project.owned_by_organization_id}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {project.owner_org_name ?? project.owned_by_organization_id}
                  </Link>
                ) : (
                  <span className="text-muted-foreground text-sm">Unknown</span>
                )}
              </div>
            </div>

            {/* Deployment Status */}
            <div className="flex items-center gap-2">
              <Rocket className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Deployment</div>
                {project.is_deployed ? (
                  <Badge variant="default" className="bg-green-600">
                    Deployed
                  </Badge>
                ) : (
                  <Badge variant="secondary">Not Deployed</Badge>
                )}
              </div>
            </div>

            {/* Created At */}
            <div className="flex items-center gap-2">
              <Calendar className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Created</div>
                <div className="text-sm" title={formatAbsoluteTime(project.created_at)}>
                  {formatRelativeTime(project.created_at)}
                </div>
              </div>
            </div>

            {/* Last Activity */}
            <div className="flex items-center gap-2">
              <Calendar className="text-muted-foreground h-4 w-4" />
              <div>
                <div className="text-muted-foreground text-xs">Last Activity</div>
                <div
                  className="text-sm"
                  title={
                    project.last_message_at
                      ? formatAbsoluteTime(project.last_message_at)
                      : undefined
                  }
                >
                  {formatRelativeTime(project.last_message_at)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Sessions Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              Sessions
            </CardTitle>
            <CardDescription>All cloud agent sessions for this project</CardDescription>
          </CardHeader>
          <CardContent>
            {project.sessions.length === 0 ? (
              <p className="text-muted-foreground text-sm">No sessions found</p>
            ) : (
              <div className="divide-border divide-y">
                {project.sessions.map(session => {
                  const isActive = session.ended_at === null;
                  return (
                    <div key={session.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="bg-muted rounded px-2 py-1 text-sm">
                          {session.cloud_agent_session_id}
                        </code>
                        <Badge variant="outline">{session.reason}</Badge>
                        <Badge
                          variant={session.worker_version === 'v2' ? 'default' : 'secondary'}
                          className={session.worker_version === 'v2' ? 'bg-green-600' : undefined}
                        >
                          {session.worker_version}
                        </Badge>
                        {isActive ? (
                          <Badge variant="default" className="bg-green-600">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Ended</Badge>
                        )}
                      </div>

                      <div className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm">
                        <span
                          className="flex items-center gap-1"
                          title={formatAbsoluteTime(session.created_at)}
                        >
                          <Clock className="h-3.5 w-3.5" />
                          Created {formatRelativeTime(session.created_at)}
                        </span>
                        {session.ended_at && (
                          <span title={formatAbsoluteTime(session.ended_at)}>
                            Ended {formatRelativeTime(session.ended_at)}
                          </span>
                        )}
                      </div>

                      {session.cli_session_id ? (
                        <div className="flex items-center gap-2">
                          <Link href={`/admin/session-traces?sessionId=${session.cli_session_id}`}>
                            <Button variant="outline" size="sm">
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Session Traces
                            </Button>
                          </Link>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">No linked CLI session</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* IDs Card */}
        <Card>
          <CardHeader>
            <CardTitle>Technical Details</CardTitle>
            <CardDescription>Internal identifiers and metadata</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-muted-foreground text-xs">Project ID</div>
              <code className="text-sm">{project.id}</code>
            </div>
            {project.deployment_id && (
              <div>
                <div className="text-muted-foreground text-xs">Deployment ID</div>
                <code className="text-sm">{project.deployment_id}</code>
              </div>
            )}
            {project.created_by_user_id && (
              <div>
                <div className="text-muted-foreground text-xs">Created By User ID</div>
                <Link
                  href={`/admin/users/${encodeURIComponent(project.created_by_user_id)}`}
                  className="text-sm text-blue-600 hover:underline"
                >
                  {project.created_by_user_id}
                </Link>
              </div>
            )}
            <div>
              <div className="text-muted-foreground text-xs">Updated At</div>
              <div className="text-sm" title={formatAbsoluteTime(project.updated_at)}>
                {formatAbsoluteTime(project.updated_at)}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppBuilderProjectDetailPage>
  );
}
