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
  Cpu,
  ExternalLink,
  Loader2,
  FileCode,
  Rocket,
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
              <div className="text-lg font-semibold">{project.title}</div>
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
                    href={`/admin/users/${project.owned_by_user_id}`}
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

        {/* Session Information Card */}
        <Card>
          <CardHeader>
            <CardTitle>Session Information</CardTitle>
            <CardDescription>Cloud Agent and CLI session details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Cloud Agent Session ID */}
            <div>
              <div className="text-muted-foreground text-sm font-medium">
                Cloud Agent Session ID
              </div>
              {project.session_id ? (
                <code className="bg-muted rounded px-2 py-1 text-sm">{project.session_id}</code>
              ) : (
                <span className="text-muted-foreground text-sm">No session</span>
              )}
            </div>

            {/* CLI Session Link */}
            <div>
              <div className="text-muted-foreground mb-2 text-sm font-medium">CLI Session</div>
              {project.cli_session_id ? (
                <div className="flex items-center gap-3">
                  <code className="bg-muted rounded px-2 py-1 text-sm">
                    {project.cli_session_id}
                  </code>
                  <Link href={`/admin/session-traces?sessionId=${project.cli_session_id}`}>
                    <Button variant="outline" size="sm">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      View Session Traces
                    </Button>
                  </Link>
                </div>
              ) : project.session_id ? (
                <span className="text-muted-foreground text-sm">
                  No linked CLI session found for this cloud agent session
                </span>
              ) : (
                <span className="text-muted-foreground text-sm">No session available</span>
              )}
            </div>
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
                  href={`/admin/users/${project.created_by_user_id}`}
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
