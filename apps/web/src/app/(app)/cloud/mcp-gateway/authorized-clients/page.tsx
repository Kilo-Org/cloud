import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { PageLayout } from '@/components/PageLayout';
import { AuthorizedClientsContent } from './AuthorizedClientsContent';

export default async function AuthorizedClientsPage() {
  await getUserFromAuthOrRedirect('/users/sign_in');

  return (
    <PageLayout title="Authorized Clients">
      <div className="space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Authorized Clients</h1>
          <p className="text-muted-foreground text-sm">
            Manage MCP clients you have authorized to use connections on your behalf.
          </p>
        </div>
        <AuthorizedClientsContent />
      </div>
    </PageLayout>
  );
}
