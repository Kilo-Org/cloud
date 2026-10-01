import { redirect } from 'next/navigation';

export default function AdminAlertingPage() {
  redirect('/admin/gateway?tab=model-status');
}
