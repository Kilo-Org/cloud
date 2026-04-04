import { redirect } from 'next/navigation';

type Props = {
  params: Promise<{ triggerId: string }>;
};

export default async function EditWebhookTriggerPage({ params }: Props) {
  const { triggerId } = await params;
  redirect(`/cloud/triggers/${triggerId}`);
}
