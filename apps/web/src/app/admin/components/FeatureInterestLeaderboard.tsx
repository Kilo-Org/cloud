'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  FeatureInterestLeaderboard as LeaderboardData,
  FeatureSlugLeaderboard,
} from '@/routers/admin-feature-interest-router';
import Link from 'next/link';
import { HelpCircle } from 'lucide-react';

type FeatureInterestLeaderboardProps = {
  leaderboard: LeaderboardData[];
  bySlug: FeatureSlugLeaderboard[];
  leaderboardQuery?: string;
  bySlugQuery?: string;
};

// Generate URL-safe slug from feature name
function getSlugForFeature(featureName: string): string {
  return featureName.toLowerCase().replace(/\s+/g, '-');
}

// Build URL with feature name as query parameter for reliable lookup
function getFeatureUrl(featureName: string): string {
  const slug = getSlugForFeature(featureName);
  const encodedName = encodeURIComponent(featureName);
  return `/admin/feature-interest/${slug}?name=${encodedName}`;
}

export function FeatureInterestLeaderboard({
  leaderboard,
  bySlug,
  leaderboardQuery,
  bySlugQuery,
}: FeatureInterestLeaderboardProps) {
  const [showLeaderboardQuery, setShowLeaderboardQuery] = useState(false);
  const [showBySlugQuery, setShowBySlugQuery] = useState(false);
  const totalUniqueSignups = leaderboard.reduce((sum, item) => sum + item.unique_signups, 0);
  const totalSignups = leaderboard.reduce((sum, item) => sum + item.total_signups, 0);

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Feature Interest Leaderboard</CardTitle>
              <p className="text-muted-foreground text-sm">
                Aggregated interest counts per feature (last 90 days)
              </p>
            </div>
            {leaderboardQuery && (
              <button
                onClick={() => setShowLeaderboardQuery(!showLeaderboardQuery)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Show PostHog query"
              >
                <HelpCircle className="h-5 w-5" />
              </button>
            )}
          </div>
          {showLeaderboardQuery && leaderboardQuery && (
            <pre className="bg-muted mt-3 overflow-x-auto rounded-md p-3 text-xs">
              <code>{leaderboardQuery.trim()}</code>
            </pre>
          )}
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground py-2 pr-3 text-left font-medium">#</th>
                  <th className="text-muted-foreground px-3 py-2 text-left font-medium">Feature</th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Unique Signups
                  </th>
                  <th className="text-muted-foreground py-2 pl-3 text-right font-medium">
                    Total Signups
                  </th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((item, index) => (
                  <tr key={item.feature} className="hover:bg-muted/50 border-b">
                    <td className="text-muted-foreground py-2 pr-3">{index + 1}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={getFeatureUrl(item.feature)}
                        className="text-blue-600 hover:underline"
                      >
                        {item.feature}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{item.unique_signups}</td>
                    <td className="py-2 pl-3 text-right">{item.total_signups}</td>
                  </tr>
                ))}
                {leaderboard.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-muted-foreground py-4 text-center">
                      No feature interest data available
                    </td>
                  </tr>
                )}
              </tbody>
              {leaderboard.length > 0 && (
                <tfoot>
                  <tr className="font-medium">
                    <td className="py-2 pr-3"></td>
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right">{totalUniqueSignups}</td>
                    <td className="py-2 pl-3 text-right">{totalSignups}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Signups by Feature Page</CardTitle>
              <p className="text-muted-foreground text-sm">
                Single-feature signups by landing page (last 90 days)
              </p>
            </div>
            {bySlugQuery && (
              <button
                onClick={() => setShowBySlugQuery(!showBySlugQuery)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Show PostHog query"
              >
                <HelpCircle className="h-5 w-5" />
              </button>
            )}
          </div>
          {showBySlugQuery && bySlugQuery && (
            <pre className="bg-muted mt-3 overflow-x-auto rounded-md p-3 text-xs">
              <code>{bySlugQuery.trim()}</code>
            </pre>
          )}
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground py-2 pr-3 text-left font-medium">#</th>
                  <th className="text-muted-foreground px-3 py-2 text-left font-medium">
                    Feature Slug
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Unique Signups
                  </th>
                  <th className="text-muted-foreground py-2 pl-3 text-right font-medium">
                    Total Signups
                  </th>
                </tr>
              </thead>
              <tbody>
                {bySlug.map((item, index) => (
                  <tr key={item.feature_slug} className="hover:bg-muted/50 border-b">
                    <td className="text-muted-foreground py-2 pr-3">{index + 1}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/feature-interest/${item.feature_slug}`}
                        className="text-blue-600 hover:underline"
                      >
                        {item.feature_slug}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{item.unique_signups}</td>
                    <td className="py-2 pl-3 text-right">{item.total_signups}</td>
                  </tr>
                ))}
                {bySlug.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-muted-foreground py-4 text-center">
                      No feature page signup data available
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
