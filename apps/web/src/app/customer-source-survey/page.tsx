import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';

export default async function CustomerSourceSurveyPage({ searchParams }: AppPageProps) {
  await getUserFromAuthOrRedirect('/users/sign_in');
  const params = await searchParams;

  const callbackParam = params.callbackPath;
  const redirectPath =
    callbackParam && typeof callbackParam === 'string' && isValidCallbackPath(callbackParam)
      ? callbackParam
      : '/get-started';

  redirect(redirectPath);
}
