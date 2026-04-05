import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { CustomerSourceSurvey } from '@/components/CustomerSourceSurvey';

export default async function CustomerSourceSurveyPage({ searchParams }: AppPageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  const params = await searchParams;

  // Determine where to go after survey
  const callbackParam = params.callbackPath;
  const redirectPath =
    callbackParam && typeof callbackParam === 'string' && isValidCallbackPath(callbackParam)
      ? callbackParam
      : '/get-started';

  // If already answered, skip past
  if (user.customer_source !== null) {
    redirect(redirectPath);
  }

  return (
    <KiloCardLayout title="Where did you hear about Kilo Code?" className="max-w-2xl">
      <CustomerSourceSurvey redirectPath={redirectPath} />
    </KiloCardLayout>
  );
}
