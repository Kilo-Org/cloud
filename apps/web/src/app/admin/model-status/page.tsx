import { redirect } from 'next/navigation';

export default function ModelStatusPage() {
  redirect('/admin/gateway?tab=model-status');
}
