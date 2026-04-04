import { redirect } from 'next/navigation';

type Props = {
  params: Promise<{ id: string; triggerId: string }>;
};

export default async function OrganizationEditWebhookPage({ params }: Props) {
  const { id, triggerId } = await params;
  redirect(`/organizations/${id}/cloud/triggers/${triggerId}`);
}
