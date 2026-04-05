import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UserAdminHeuristicAbuse } from '@/app/admin/components/UserAdmin/UserAdminHeuristicAbuse';
import { findUserById } from '@/lib/user';
import { redirect } from 'next/navigation';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { getUserFromAuth } from '@/lib/user.server';

export default async function UserHeuristicAbusePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Check authentication first
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  const { id } = await params;
  const userId = decodeURIComponent(id);
  const user = await findUserById(userId);

  if (!user) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>User Not Found</CardTitle>
          <CardDescription>The requested user could not be found</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            The user with ID &quot;{userId}&quot; does not exist or you don&apos;t have permission
            to view it.
          </p>
        </CardContent>
      </Card>
    );
  }

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/users">Users</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbLink href={`/admin/users/${encodeURIComponent(user.id)}`}>
          {user.google_user_email}
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Heuristic Abuse</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-8">
        <UserAdminHeuristicAbuse id={user.id} />
      </div>
    </AdminPage>
  );
}
