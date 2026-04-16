import { redirect } from 'next/navigation';

export default function SafetyIdentifiersPage() {
  redirect('/admin/backfills');
}
