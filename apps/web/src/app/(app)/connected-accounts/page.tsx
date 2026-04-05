import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { PageLayout } from '@/components/PageLayout';
import { LoginMethodsWrapper } from '@/components/profile/LoginMethodsWrapper';

export default async function AccountsPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');

  return (
    <PageLayout
      title="Connected Accounts"
      subtitle="Manage your primary email and connected authentication providers"
    >
      <LoginMethodsWrapper primaryEmail={user.google_user_email} />
    </PageLayout>
  );
}
