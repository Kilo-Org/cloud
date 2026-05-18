import { redirect } from 'next/navigation';

export default function AdminModelExperimentsPage() {
  redirect('/admin/gateway?tab=model-experiments');
}
