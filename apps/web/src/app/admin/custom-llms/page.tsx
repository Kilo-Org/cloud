import { redirect } from 'next/navigation';

export default function AdminCustomLlmsPage() {
  redirect('/admin/gateway?tab=custom-llms');
}
