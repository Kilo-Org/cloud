import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { PageLayout } from '@/components/PageLayout';
import { LoginMethodsWrapper } from '@/components/profile/LoginMethodsWrapper';
import { isAdminStepUpUiVisible } from '@/lib/admin/step-up-ui';

export default async function AccountsPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  const showAdminStepUpNote = await isAdminStepUpUiVisible(user);

  return (
    <PageLayout
      title="Connected Accounts"
      subtitle="Manage your primary email and connected authentication providers"
    >
      <LoginMethodsWrapper
        primaryEmail={user.google_user_email}
        showAdminStepUpNote={showAdminStepUpNote}
      />
    </PageLayout>
  );
}
