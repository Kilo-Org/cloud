import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';
import { AdminWebhookTriggersList } from '@/app/admin/webhooks/AdminWebhookTriggersList';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import { eq } from 'drizzle-orm';

export default async function AdminUserWebhooksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  const { id } = await params;
  const userId = decodeURIComponent(id);

  const user = await db.query.kilocode_users.findFirst({
    columns: {
      id: true,
      google_user_email: true,
      google_user_name: true,
    },
    where: eq(kilocode_users.id, userId),
  });

  if (!user) {
    redirect('/admin/users');
  }

  const label = user.google_user_name
    ? `${user.google_user_name} (${user.google_user_email})`
    : user.google_user_email;

  return (
    <AdminWebhookTriggersList
      userId={user.id}
      label={label}
      backHref={`/admin/users/${encodeURIComponent(user.id)}`}
      detailBasePath={`/admin/users/${encodeURIComponent(user.id)}/webhooks`}
    />
  );
}
