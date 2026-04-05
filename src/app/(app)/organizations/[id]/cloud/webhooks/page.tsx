import { redirect } from 'next/navigation';

type Props = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationWebhooksPage({ params }: Props) {
  const { id } = await params;
  redirect(`/organizations/${id}/cloud/triggers`);
}
