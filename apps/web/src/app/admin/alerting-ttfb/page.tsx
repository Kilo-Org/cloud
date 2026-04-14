import { redirect } from 'next/navigation';

export default function AdminAlertingTtfbPage() {
  redirect('/admin/alerting?tab=ttfb');
}
