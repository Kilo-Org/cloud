import { Suspense } from 'react';
import { UsageAnalyticsDashboard } from '@/components/usage-analytics/UsageAnalyticsDashboard';
import { ChatGptUsageLink } from '@/components/chatgpt/ChatGptUsageLink';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export default async function UsagePage() {
  const user = await getUserFromAuthOrRedirect();

  return (
    <Suspense>
      <UsageAnalyticsDashboard
        context="personal"
        title="Usage"
        notice={<ChatGptUsageLink kiloUserId={user.id} />}
      />
    </Suspense>
  );
}
