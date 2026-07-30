import { redirect } from 'next/navigation';

export default async function OrganizationKiloPassReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/organizations/${id}/subscriptions/kilo-pass/setup`);
}
