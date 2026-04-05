import { redirect } from 'next/navigation';

type Props = {
  params: Promise<{ id: string; triggerId: string }>;
};

export default async function OrganizationWebhookRequestsPage({ params }: Props) {
  const { id, triggerId } = await params;
  redirect(`/organizations/${id}/cloud/triggers/${triggerId}/requests`);
}
