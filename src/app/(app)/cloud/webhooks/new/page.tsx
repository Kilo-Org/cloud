import { redirect } from 'next/navigation';

export default function CreateWebhookTriggerPage() {
  redirect('/cloud/triggers/new');
}
