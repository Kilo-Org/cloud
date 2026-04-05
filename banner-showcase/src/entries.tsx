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

type Variant = {
  label: string;
  before: React.ReactNode;
  after: React.ReactNode;
};

type Entry = {
  name: string;
  file: string;
  variants: Variant[];
};

export const entries: Entry[] = [
  {
    name: 'OldSessionBanner',
    file: 'src/components/cloud-agent-next/OldSessionBanner.tsx',
    variants: [
      {
        label: 'Default',
        before: (
          <Alert variant="warning">
            <Info className="h-4 w-4" />
            <AlertTitle>Legacy Session</AlertTitle>
            <AlertDescription>
              <p className="mb-3">This is a legacy session displayed in read-only mode. You can start a new session to continue working.</p>
              <Button size="sm" variant="outline" onClick={() => {}}>Start New Session</Button>
            </AlertDescription>
          </Alert>
        ),
        after: (
          <Banner color="amber">
            <Banner.Icon><Info /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Legacy Session</Banner.Title>
              <Banner.Description>This is a legacy session displayed in read-only mode. You can start a new session to continue working.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Start New Session</Banner.Button>
            </Banner.Action>
          </Banner>
        ),
      },
    ],
  },
  {
    name: 'ErrorBanner',
    file: 'src/components/cloud-agent-next/ErrorBanner.tsx',
    variants: [
      {
        label: 'Default',
        before: (
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
            <button className="absolute top-2 right-2 rounded-md p-1 opacity-70 hover:opacity-100" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </Alert>
        ),
        after: (
          <Banner color="red">
            <Banner.Icon><AlertCircle /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Error</Banner.Title>
              <Banner.Description>Something went wrong while loading the session.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button variant="secondary" onClick={() => {}}>Retry</Banner.Button>
              <Banner.Button variant="ghost" onClick={() => {}}>Dismiss</Banner.Button>
            </Banner.Action>
          </Banner>
        ),
      },
    ],
  },
  {
    name: 'AdminViewingBanner',
    file: 'src/components/gastown/AdminViewingBanner.tsx',
    variants: [
      {
        label: 'Default',
        before: (
          <Alert variant="warning" className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
            <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <AlertTitle className="text-amber-800 dark:text-amber-200">Viewing as admin</AlertTitle>
            <AlertDescription className="text-amber-700 dark:text-amber-300">
              This town belongs to org <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/40">org_abc123</code>. Changes to settings and destructive actions are restricted.
            </AlertDescription>
          </Alert>
        ),
        after: (
          <Banner color="amber">
            <Banner.Icon><ShieldAlert /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Viewing as admin</Banner.Title>
              <Banner.Description>
                This town belongs to org <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/40">org_abc123</code>. Changes to settings and destructive actions are restricted.
              </Banner.Description>
            </Banner.Content>
          </Banner>
        ),
      },
    ],
  },
  {
    name: 'BillingBanner',
    file: 'src/app/(app)/claw/components/billing/BillingBanner.tsx',
    variants: [
      {
        label: 'trial_active',
        before: (
          <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-blue-500/10 border-blue-500/30 text-blue-400')}>
            <Clock className="h-6 w-6 shrink-0" />
            <div className="flex-1">
              <div className="mb-0.5 text-sm font-bold">Free Trial — 12 days remaining</div>
              <p className="text-muted-foreground text-sm">Your trial expires on April 15, 2026.</p>
            </div>
            <Button onClick={() => {}} variant="primary" className="shrink-0">Subscribe Now</Button>
          </div>
        ),
        after: (
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
        ),
      },
      {
        label: 'trial_ending_soon',
        before: (
          <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-amber-500/10 border-amber-500/30 text-amber-400')}>
            <AlertCircle className="h-6 w-6 shrink-0" />
            <div className="flex-1">
              <div className="mb-0.5 text-sm font-bold">Free Trial Ending Soon — 3 days left</div>
              <p className="text-muted-foreground text-sm">Your trial expires on April 6, 2026.</p>
            </div>
            <Button onClick={() => {}} variant="primary" className="shrink-0">Subscribe Now</Button>
          </div>
        ),
        after: (
          <Banner color="amber">
            <Banner.Icon><AlertCircle /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Free Trial Ending Soon — 3 days left</Banner.Title>
              <Banner.Description>Your trial expires on April 6, 2026.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Subscribe Now</Banner.Button>
            </Banner.Action>
          </Banner>
        ),
      },
      {
        label: 'subscription_past_due',
        before: (
          <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-red-500/10 border-red-500/30 text-red-400')}>
            <CreditCard className="h-6 w-6 shrink-0" />
            <div className="flex-1">
              <div className="mb-0.5 text-sm font-bold">Payment failed — action required</div>
              <p className="text-muted-foreground text-sm">Your subscription payment failed. Update your payment method.</p>
            </div>
            <Button onClick={() => {}} variant="primary" className="shrink-0">Update Payment</Button>
          </div>
        ),
        after: (
          <Banner color="red">
            <Banner.Icon><CreditCard /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Payment failed — action required</Banner.Title>
              <Banner.Description>Your subscription payment failed. Update your payment method.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Update Payment</Banner.Button>
            </Banner.Action>
          </Banner>
        ),
      },
    ],
  },
  {
    name: 'FreeTrialWarningBanner',
    file: 'src/components/organizations/FreeTrialWarningBanner.tsx',
    variants: [
      {
        label: 'trial_active',
        before: (
          <div className={cn('flex w-full items-center gap-4 border-b p-4', 'bg-blue-500/10 border-blue-500/50 text-blue-100')}>
            <Clock className="h-6 w-6 shrink-0 text-blue-400" />
            <div className="flex-1">
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-bold">Free Kilo Team Trial Active</span>
                <span className="opacity-70">&bull; 14 days left</span>
              </div>
              <p className="text-sm">Your trial expires on April 17, 2026.</p>
            </div>
            <Button onClick={() => {}} className="shrink-0 bg-blue-600 text-white hover:bg-blue-700">Upgrade Now</Button>
          </div>
        ),
        after: (
          <Banner color="blue">
            <Banner.Icon><Clock /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Free Kilo Team Trial Active <span className="ml-2 opacity-70">&bull; 14 days left</span></Banner.Title>
              <Banner.Description>Your trial expires on April 17, 2026.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Upgrade Now</Banner.Button>
            </Banner.Action>
          </Banner>
        ),
      },
      {
        label: 'ending_very_soon',
        before: (
          <div className={cn('flex w-full items-center gap-4 border-b p-4', 'bg-red-500/10 border-red-500/50 text-red-100')}>
            <AlertTriangle className="h-6 w-6 shrink-0 text-red-400" />
            <div className="flex-1">
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-bold">Free Kilo Team Trial Ending Very Soon</span>
                <span className="opacity-70">&bull; 1 day left</span>
              </div>
              <p className="text-sm">Your trial expires on April 4, 2026.</p>
            </div>
            <Button onClick={() => {}} className="shrink-0 bg-red-600 text-white hover:bg-red-700">Upgrade Now</Button>
          </div>
        ),
        after: (
          <Banner color="red">
            <Banner.Icon><AlertTriangle /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Free Kilo Team Trial Ending Very Soon <span className="ml-2 opacity-70">&bull; 1 day left</span></Banner.Title>
              <Banner.Description>Your trial expires on April 4, 2026.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Upgrade Now</Banner.Button>
            </Banner.Action>
          </Banner>
        ),
      },
    ],
  },
  {
    name: 'InsufficientBalanceBanner',
    file: 'src/components/shared/InsufficientBalanceBanner.tsx',
    variants: [
      {
        label: 'Default',
        before: (
          <div className={cn('flex w-full items-center gap-4 rounded-lg border p-4', 'border-yellow-500/50 bg-yellow-500/10 text-yellow-100')}>
            <AlertTriangle className="h-6 w-6 shrink-0 text-yellow-400" />
            <div className="flex-1">
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-bold">Insufficient Balance</span>
                <span className="opacity-70">&bull; Current: $0.42</span>
              </div>
              <p className="text-sm">App Builder requires a minimum balance of $1 to start.</p>
            </div>
            <Button onClick={() => {}} className="shrink-0 bg-yellow-600 text-white hover:bg-yellow-700">Add Credits</Button>
          </div>
        ),
        after: (
          <Banner color="amber" className="rounded-lg">
            <Banner.Icon><AlertTriangle /></Banner.Icon>
            <Banner.Content>
              <Banner.Title>Insufficient Balance <span className="ml-2 opacity-70">&bull; Current: $0.42</span></Banner.Title>
              <Banner.Description>App Builder requires a minimum balance of $1 to start.</Banner.Description>
            </Banner.Content>
            <Banner.Action>
              <Banner.Button onClick={() => {}}>Add Credits</Banner.Button>
            </Banner.Action>
          </Banner>
        ),
      },
      {
        label: 'Compact',
        before: (
          <div className={cn('flex w-full flex-col gap-3 rounded-lg border p-3', 'border-yellow-500/50 bg-yellow-500/10 text-yellow-100')}>
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
        ),
        after: (
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
        ),
      },
    ],
  },
];
