'use client';

import { useState } from 'react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { FeatureInterestLeaderboard } from '@/app/admin/components/FeatureInterestLeaderboard';
import { FeatureInterestTimeline } from '@/app/admin/components/FeatureInterestTimeline';
import {
  useFeatureInterest,
  useFeatureInterestTimeline,
} from '@/app/admin/api/features/interest/hooks';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Feature Interest</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function FeatureInterestPage() {
  const [timelineWeeks, setTimelineWeeks] = useState(12);

  const {
    data: interestData,
    isLoading: isLoadingInterest,
    error: interestError,
  } = useFeatureInterest();
  const {
    data: timelineData,
    isLoading: isLoadingTimeline,
    error: timelineError,
  } = useFeatureInterestTimeline(timelineWeeks);

  const isLoading = isLoadingInterest || isLoadingTimeline;
  const error = interestError || timelineError;

  if (isLoading) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Feature Interest Analytics</h2>
          </div>
          <div className="text-muted-foreground space-y-2">
            <p>Track user interest in upcoming features from early access signups.</p>
          </div>
          <div>Loading...</div>
        </div>
      </AdminPage>
    );
  }

  if (error) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Feature Interest Analytics</h2>
          </div>
          <div className="text-muted-foreground space-y-2">
            <p>Track user interest in upcoming features from early access signups.</p>
          </div>
          <div className="text-red-500">
            Error: {error instanceof Error ? error.message : 'An error occurred'}
          </div>
        </div>
      </AdminPage>
    );
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full max-w-6xl flex-col gap-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Feature Interest Analytics</h2>
            <p className="text-muted-foreground mt-1">
              Track user interest in upcoming features from early access signups on the landing
              page.
            </p>
          </div>
          <a
            href="https://us.posthog.com/project/141915/events?eventType=early_access_signup_single_feature"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:bg-background inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none"
          >
            View in PostHog
          </a>
        </div>

        {interestData && (
          <FeatureInterestLeaderboard
            leaderboard={interestData.leaderboard}
            bySlug={interestData.bySlug}
            leaderboardQuery={interestData.leaderboardQuery}
            bySlugQuery={interestData.bySlugQuery}
          />
        )}

        <div className="bg-background flex items-center gap-4 rounded-lg border border-gray-200 p-4">
          <span className="text-sm font-medium text-gray-700">Timeline Range:</span>
          <div className="flex gap-2">
            {[4, 8, 12, 26, 52].map(weeks => (
              <button
                key={weeks}
                onClick={() => setTimelineWeeks(weeks)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  timelineWeeks === weeks
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {weeks}w
              </button>
            ))}
          </div>
        </div>

        {timelineData && (
          <FeatureInterestTimeline timeline={timelineData.timeline} query={timelineData.query} />
        )}
      </div>
    </AdminPage>
  );
}
