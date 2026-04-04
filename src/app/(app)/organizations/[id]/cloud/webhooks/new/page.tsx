import { redirect } from 'next/navigation';

type Props = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCreateWebhookPage({ params }: Props) {
  const { id } = await params;
  redirect(`/organizations/${id}/cloud/triggers/new`);
}
