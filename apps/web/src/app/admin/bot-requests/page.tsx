import { redirect } from 'next/navigation';

export default function BotRequestsPage() {
  redirect('/admin/bots?tab=kilo-bot');
}
