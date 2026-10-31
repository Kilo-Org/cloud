import { Suspense } from 'react';
import { UsageAnalyticsDashboard } from '@/components/usage-analytics/UsageAnalyticsDashboard';
import { ChatGptUsageLink } from '@/components/chatgpt/ChatGptUsageLink';
import { AiRequestsLink } from '@/components/usage-requests/AiRequestsLink';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';

export default async function UsagePage() {
  const user = await getUserFromAuthOrRedirect();

  return (
    <Suspense>
      <UsageAnalyticsDashboard
        context="personal"
        title="Usage"
        notice={
          <>
            <AiRequestsLink />
            <ChatGptUsageLink kiloUserId={user.id} />
          </>
        }
      />
    </Suspense>
  );
}
