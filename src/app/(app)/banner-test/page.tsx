'use client';

import {
  AlertCircle,
  AlertTriangle,
  Clock,
  CreditCard,
  Info,
  ShieldAlert,
  X,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/shared/Banner';
import { cn } from '@/lib/utils';

/**
 * Temporary test page for capturing before/after screenshots of banner migrations.
 * DELETE THIS FILE when done with the standardize-banners branch.
 */
export default function BannerTestPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 p-8">
      <h1 className="text-2xl font-bold">Banner Migration — Before / After</h1>

      {/* ═══════════════════════════════════════════════════
          1a. OldSessionBanner
          ═══════════════════════════════════════════════════ */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1a. OldSessionBanner</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — Alert variant=&quot;warning&quot;</p>
        <div id="before-old-session">
          <Alert variant="warning" className="mb-4">
            <Info className="h-4 w-4" />
            <AlertTitle>Legacy Session</AlertTitle>
            <AlertDescription>
              <p className="mb-3">
                This is a legacy session displayed in read-only mode. You can start a new session to
                continue working.
              </p>
              <Button size="sm" variant="outline" onClick={() => {}}>
                Start New Session
              </Button>
            </AlertDescription>
          </Alert>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;amber&quot;</p>
        <div id="after-old-session">
          <Banner color="amber" className="mb-4">
            <Banner.Icon><Info /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Legacy Session</Banner.Title>
              <Banner.Description>
                This is a legacy session displayed in read-only mode. You can start a new session to
                continue working.
              </Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Start New Session</Banner.Button>
            </Banner.Action>
          </Banner>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          1b. ErrorBanner
          ═══════════════════════════════════════════════════ */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1b. ErrorBanner</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — Alert variant=&quot;destructive&quot;</p>
        <div id="before-error">
          <Alert variant="destructive" className="relative">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              <p className="mb-3">Something went wrong while loading the session.</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => {}}>Retry</Button>
                <Button size="sm" variant="ghost" onClick={() => {}}>Dismiss</Button>
              </div>
            </AlertDescription>
            <button
              className="absolute top-2 right-2 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </Alert>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;red&quot;</p>
        <div id="after-error">
          <Banner color="red">
            <Banner.Icon><AlertCircle /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Error</Banner.Title>
              <Banner.Description>Something went wrong while loading the session.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Retry</Banner.Button>
              <Banner.Button onClick={() => {}}>Dismiss</Banner.Button>
            </Banner.Action>
            <Banner.Dismiss onDismiss={() => {}} />
          </Banner>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          1c. AdminViewingBanner
          ═══════════════════════════════════════════════════ */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1c. AdminViewingBanner</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — Alert variant=&quot;warning&quot; + overrides</p>
        <div id="before-admin-viewing">
          <Alert variant="warning" className="mb-4 border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
            <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <AlertTitle className="text-amber-800 dark:text-amber-200">Viewing as admin</AlertTitle>
            <AlertDescription className="text-amber-700 dark:text-amber-300">
              This town belongs to org{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/40">
                org_abc123
              </code>
              . Changes to settings and destructive actions are restricted.
            </AlertDescription>
          </Alert>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;amber&quot;</p>
        <div id="after-admin-viewing">
          <Banner color="amber" className="mb-4">
            <Banner.Icon><ShieldAlert /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Viewing as admin</Banner.Title>
              <Banner.Description>
                This town belongs to org{' '}
                <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/40">
                  org_abc123
                </code>
                . Changes to settings and destructive actions are restricted.
              </Banner.Description>
            </Banner.Content>
          </Banner>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          1d. BillingBanner — 3 states
          ═══════════════════════════════════════════════════ */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1d. BillingBanner — trial_active</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — hand-rolled div</p>
        <div id="before-billing-active">
          <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-blue-500/10', 'border-blue-500/30', 'text-blue-400')}>
            <div className="flex shrink-0 items-center text-blue-400">
              <Clock className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="mb-0.5 text-sm font-bold">Free Trial — 12 days remaining</div>
              <p className="text-muted-foreground text-sm">Your trial expires on April 15, 2026.</p>
            </div>
            <Button onClick={() => {}} variant="primary" className="shrink-0">Subscribe Now</Button>
          </div>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;blue&quot;</p>
        <div id="after-billing-active">
          <Banner color="blue">
            <Banner.Icon><Clock /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Free Trial — 12 days remaining</Banner.Title>
              <Banner.Description>Your trial expires on April 15, 2026.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Subscribe Now</Banner.Button>
            </Banner.Action>
          </Banner>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1d. BillingBanner — trial_ending_soon</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — hand-rolled div</p>
        <div id="before-billing-ending">
          <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-amber-500/10', 'border-amber-500/30', 'text-amber-400')}>
            <div className="flex shrink-0 items-center text-amber-400">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="mb-0.5 text-sm font-bold">Free Trial Ending Soon — 3 days left</div>
              <p className="text-muted-foreground text-sm">Your trial expires on April 6, 2026. Subscribe now to avoid interruption.</p>
            </div>
            <Button onClick={() => {}} variant="primary" className="shrink-0">Subscribe Now</Button>
          </div>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;amber&quot;</p>
        <div id="after-billing-ending">
          <Banner color="amber">
            <Banner.Icon><AlertCircle /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Free Trial Ending Soon — 3 days left</Banner.Title>
              <Banner.Description>Your trial expires on April 6, 2026. Subscribe now to avoid interruption.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Subscribe Now</Banner.Button>
            </Banner.Action>
          </Banner>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1d. BillingBanner — subscription_past_due</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — hand-rolled div</p>
        <div id="before-billing-pastdue">
          <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-red-500/10', 'border-red-500/30', 'text-red-400')}>
            <div className="flex shrink-0 items-center text-red-400">
              <CreditCard className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="mb-0.5 text-sm font-bold">Payment failed — action required</div>
              <p className="text-muted-foreground text-sm">Your subscription payment failed. Update your payment method.</p>
            </div>
            <Button onClick={() => {}} variant="primary" className="shrink-0">Update Payment</Button>
          </div>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;red&quot;</p>
        <div id="after-billing-pastdue">
          <Banner color="red">
            <Banner.Icon><CreditCard /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Payment failed — action required</Banner.Title>
              <Banner.Description>Your subscription payment failed. Update your payment method to keep your instance running.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Update Payment</Banner.Button>
            </Banner.Action>
          </Banner>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          1e. FreeTrialWarningBanner — 2 states
          ═══════════════════════════════════════════════════ */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1e. FreeTrialWarningBanner — trial_active</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — hand-rolled div with border-b</p>
        <div id="before-freetrial-active">
          <div className={cn('flex w-full items-center gap-4 border-b p-4', 'bg-blue-500/10', 'border-blue-500/50', 'text-blue-100')}>
            <div className="flex shrink-0 items-center text-blue-400">
              <Clock className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-bold">Free Kilo Team Trial Active</span>
                <span className="flex gap-1 opacity-70"><span>&bull;</span><span>14 days left</span></span>
              </div>
              <p className="text-sm">Your trial expires on April 17, 2026.</p>
            </div>
            <Button onClick={() => {}} className="shrink-0 bg-blue-600 text-white hover:bg-blue-700">Upgrade Now</Button>
          </div>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;blue&quot;</p>
        <div id="after-freetrial-active">
          <Banner color="blue">
            <Banner.Icon><Clock /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>
                Free Kilo Team Trial Active
                <span className="ml-2 opacity-70">&bull; 14 days left</span>
              </Banner.Title>
              <Banner.Description>Your trial expires on April 17, 2026.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Upgrade Now</Banner.Button>
            </Banner.Action>
          </Banner>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1e. FreeTrialWarningBanner — trial_ending_very_soon</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — hand-rolled div with border-b</p>
        <div id="before-freetrial-ending">
          <div className={cn('flex w-full items-center gap-4 border-b p-4', 'bg-red-500/10', 'border-red-500/50', 'text-red-100')}>
            <div className="flex shrink-0 items-center text-red-400">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-bold">Free Kilo Team Trial Ending Very Soon</span>
                <span className="flex gap-1 opacity-70"><span>&bull;</span><span>1 day left</span></span>
              </div>
              <p className="text-sm">Your trial expires on April 4, 2026.</p>
            </div>
            <Button onClick={() => {}} className="shrink-0 bg-red-600 text-white hover:bg-red-700">Upgrade Now</Button>
          </div>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;red&quot;</p>
        <div id="after-freetrial-ending">
          <Banner color="red">
            <Banner.Icon><AlertTriangle /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>
                Free Kilo Team Trial Ending Very Soon
                <span className="ml-2 opacity-70">&bull; 1 day left</span>
              </Banner.Title>
              <Banner.Description>Your trial expires on April 4, 2026.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Upgrade Now</Banner.Button>
            </Banner.Action>
          </Banner>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          1f. InsufficientBalanceBanner — 2 variants
          ═══════════════════════════════════════════════════ */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1f. InsufficientBalanceBanner — default</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — hand-rolled div (yellow scheme)</p>
        <div id="before-insufficient-default">
          <div className={cn('flex w-full items-center gap-4 rounded-lg border p-4', 'border-yellow-500/50', 'bg-yellow-500/10', 'text-yellow-100')}>
            <div className="flex shrink-0 items-center text-yellow-400">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-bold">Insufficient Balance</span>
                <span className="flex gap-1 opacity-70"><span>&bull;</span><span>Current: $0.42</span></span>
              </div>
              <p className="text-sm">App Builder requires a minimum balance of $1 to start.</p>
            </div>
            <Button onClick={() => {}} className="shrink-0 bg-yellow-600 text-white hover:bg-yellow-700">Add Credits</Button>
          </div>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;amber&quot;</p>
        <div id="after-insufficient-default">
          <Banner color="amber" className="rounded-lg">
            <Banner.Icon><AlertTriangle /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>
                Insufficient Balance
                <span className="ml-2 opacity-70">&bull; Current: $0.42</span>
              </Banner.Title>
              <Banner.Description>App Builder requires a minimum balance of $1 to start.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Add Credits</Banner.Button>
            </Banner.Action>
          </Banner>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground">1f. InsufficientBalanceBanner — compact</h2>

        {/* BEFORE */}
        <p className="text-xs font-medium text-red-400">Before — hand-rolled div (yellow, compact)</p>
        <div id="before-insufficient-compact">
          <div className={cn('flex w-full flex-col gap-3 rounded-lg border p-3', 'border-yellow-500/50', 'bg-yellow-500/10', 'text-yellow-100')}>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
              <span className="text-sm font-bold">Insufficient Balance</span>
              <span className="text-xs opacity-70">($0.42)</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs opacity-80">Add credits to continue</p>
              <Button size="sm" onClick={() => {}} className="shrink-0 bg-yellow-600 text-white hover:bg-yellow-700">Add Credits</Button>
            </div>
          </div>
        </div>

        {/* AFTER */}
        <p className="text-xs font-medium text-green-400">After — Banner color=&quot;amber&quot; (compact)</p>
        <div id="after-insufficient-compact">
          <Banner color="amber" className="flex-col gap-3 rounded-lg p-3 sm:items-start">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="text-sm font-bold">Insufficient Balance</span>
              <span className="text-xs opacity-70">($0.42)</span>
            </div>
            <div className="flex w-full items-center justify-between gap-2">
              <p className="text-xs opacity-80">Add credits to continue</p>
              <Banner.Button onClick={() => {}} className="shrink-0 text-xs">Add Credits</Banner.Button>
            </div>
          </Banner>
        </div>
      </section>
    </div>
  );
}
