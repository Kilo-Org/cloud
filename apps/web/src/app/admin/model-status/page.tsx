import { redirect } from 'next/navigation';

export default function ModelStatusPage() {
  redirect('/admin/alerting?tab=model-status');
}
