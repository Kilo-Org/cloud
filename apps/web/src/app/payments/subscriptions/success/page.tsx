import { StripeSessionStatusChecker } from '@/components/payment/StripeSessionStatusChecker';
import { STRIPE_SUB_QUERY_STRING_KEY } from '@/lib/organizations/constants';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import assert from 'assert';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await getUserFromAuthOrRedirect();
  const params = await searchParams;
  const sessionId = params[STRIPE_SUB_QUERY_STRING_KEY];
  const organizationId = params['organizationId'];
  assert(sessionId && typeof sessionId === 'string');
  assert(organizationId && typeof organizationId === 'string');
  return <StripeSessionStatusChecker organizationId={organizationId} sessionId={sessionId} />;
}
