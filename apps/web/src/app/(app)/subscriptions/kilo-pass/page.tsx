import { redirect } from 'next/navigation';

import { PageContainer } from '@/components/layouts/PageContainer';
import { KiloPassDetail } from '@/components/subscriptions/kilo-pass/KiloPassDetail';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getKiloPassStateForUser } from '@kilocode/web-shared/lib/kilo-pass/state';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';

export default async function KiloPassSubscriptionPage() {
  const user = await getUserFromAuthOrRedirect(
    '/users/sign_in?callbackPath=/subscriptions/kilo-pass'
  );
  const subscription = await getKiloPassStateForUser(db, user.id);

  if (!subscription) {
    redirect('/subscriptions');
  }

  return (
    <PageContainer>
      <KiloPassDetail />
    </PageContainer>
  );
}
