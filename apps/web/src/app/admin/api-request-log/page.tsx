import { redirect } from 'next/navigation';

export default function ApiRequestLogPage() {
  redirect('/admin/gateway?tab=api-request-log');
}
