import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Clock, UserCheck } from 'lucide-react';
import { getUserFromAuth } from '@/lib/user.server';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { Button } from '@/components/ui/button';
import {
  CREDIT_CAMPAIGN_SLUG_FORMAT,
  countCampaignRedemptions,
  isCampaignEligible,
  lookupCampaignBySlug,
} from '@/lib/credit-campaigns';

type PageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * Public entry point for an admin-managed signup-bonus URL campaign.
 *
 * Routing decisions:
 * - Unknown / malformed slug → redirect to `/`. Mistyped URLs are harmless.
 * - Logged-in existing user → render a "for new accounts" message; no credit.
 * - Logged-out + eligible campaign → redirect through sign-in with the
 *   `/c/<slug>` callback path, matching the `/openclaw-advisor` precedent
 *   so the existing Stytch/Turnstile validation gate applies unchanged.
 * - Logged-out + ineligible (inactive / ended / capped) → render a
 *   message explaining the state with a "Continue to signup" button
 *   that proceeds through plain sign-in (no bonus attribution).
 */
export default async function CreditCampaignLandingPage({ params }: PageProps) {
  const { slug: rawSlug } = await params;
  const slug = rawSlug.toLowerCase();
  if (!CREDIT_CAMPAIGN_SLUG_FORMAT.test(slug)) redirect('/');

  const campaign = await lookupCampaignBySlug(slug);
  if (!campaign) redirect('/');

  const { user } = await getUserFromAuth({
    adminOnly: false,
    DANGEROUS_allowBlockedUsers: true,
  });

  if (user) {
    return (
      <KiloCardLayout contentClassName="flex flex-col items-center gap-6 px-6 pt-4 pb-10 text-center">
        <div className="bg-muted flex h-12 w-12 items-center justify-center rounded-full">
          <UserCheck className="text-muted-foreground h-6 w-6" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">You&apos;re already signed in</h1>
          <p className="text-muted-foreground max-w-md">
            This promotion is for new accounts only. We&apos;re sorry, your account isn&apos;t
            eligible.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild>
            <Link href="/">Go to your dashboard</Link>
          </Button>
        </div>
      </KiloCardLayout>
    );
  }

  const redemptionCount = await countCampaignRedemptions(campaign.credit_category);
  const eligibility = isCampaignEligible(campaign, redemptionCount);

  if (eligibility.ok) {
    // Slug is already validated against CREDIT_CAMPAIGN_SLUG_FORMAT, so no
    // per-char encoding is needed inside the callback path. The outer
    // encodeURIComponent keeps the `/` in `/c/<slug>` travelling as a
    // single query-param value into /users/sign_in.
    const callbackPath = `/c/${slug}`;
    redirect(`/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`);
  }

  const reasonMessage = (() => {
    switch (eligibility.reason) {
      case 'ended': {
        const ended = campaign.campaign_ends_at
          ? new Date(campaign.campaign_ends_at).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : null;
        return ended ? `This promotion ended on ${ended}.` : 'This promotion has ended.';
      }
      case 'capped':
        return 'This promotion has reached its redemption limit.';
      case 'inactive':
      default:
        return 'This promotion is no longer active.';
    }
  })();

  return (
    <KiloCardLayout contentClassName="flex flex-col items-center gap-6 px-6 pt-4 pb-10 text-center">
      <div className="bg-muted flex h-12 w-12 items-center justify-center rounded-full">
        <Clock className="text-muted-foreground h-6 w-6" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Promotion unavailable</h1>
        <p className="text-muted-foreground max-w-md">{reasonMessage}</p>
        <p className="text-muted-foreground max-w-md text-sm">
          You can still create an account, but the promotion is no longer available.
        </p>
      </div>
      <Button asChild>
        <Link href="/users/sign_in">Continue to signup</Link>
      </Button>
    </KiloCardLayout>
  );
}
