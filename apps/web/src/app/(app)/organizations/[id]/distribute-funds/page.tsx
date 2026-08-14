import { redirect } from 'next/navigation';

export default async function OrganizationDistributeFundsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/organizations/${encodeURIComponent(id)}/sub-organizations/distribute-funds`);
}
