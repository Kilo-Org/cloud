import React from 'react';
import type { StripeRenewalPreviewCounts } from '@/lib/kiloclaw/admin-stripe-renewal-batch';

export function KiloclawStripeRenewalPreview({ counts }: { counts: StripeRenewalPreviewCounts }) {
  return (
    <div className="space-y-2">
      <p className="text-sm tabular-nums">
        {counts.renewing === 0 ? (
          'No subscriptions are currently set to renew.'
        ) : (
          <>
            <strong>{counts.renewing}</strong>{' '}
            {counts.renewing === 1 ? 'subscription is' : 'subscriptions are'} currently set to renew
            and will be stopped at the end of {counts.renewing === 1 ? 'its' : 'their'} current
            term.
          </>
        )}
      </p>
      <p className="text-muted-foreground text-sm tabular-nums">
        {counts.alreadyEnding} already ending and {counts.canceled} canceled will be checked and
        skipped ({counts.total} total).
      </p>
    </div>
  );
}
