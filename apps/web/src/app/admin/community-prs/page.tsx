import { ExternalLink, GitPullRequest } from 'lucide-react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const COMMUNITY_DASHBOARD_URL = 'https://community-contributions-dashboard.vercel.app/';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Community Contributions</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function CommunityContributionsAdminPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-bold">Community Contributions</h2>
          <p className="text-muted-foreground mt-1">
            Community contribution tracking now lives in the external dashboard.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="bg-muted flex size-10 items-center justify-center rounded-lg border">
              <GitPullRequest className="size-5" />
            </div>
            <CardTitle>Open the community dashboard</CardTitle>
            <CardDescription>
              Use the dedicated dashboard for contribution metrics, community PR tracking, and
              reporting.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href={COMMUNITY_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
                Open community dashboard
                <ExternalLink className="size-4" />
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  );
}
