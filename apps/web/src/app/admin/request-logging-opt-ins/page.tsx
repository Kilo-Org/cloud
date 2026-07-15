import { redirect } from 'next/navigation';

export default function RequestLoggingOptInsPage() {
  redirect('/admin/gateway?tab=request-logging-opt-ins');
}
