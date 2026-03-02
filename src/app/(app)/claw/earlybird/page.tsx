'use client';

import { useUser } from '@/hooks/useUser';
import { PageLayout } from '@/components/PageLayout';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/00wcN64ot27OaIK0K4dAk00';
const PROMO_CODE = 'KILOCLAWEARLYBIRD';

function buildStripeUrl(email: string | undefined) {
  const url = new URL(STRIPE_PAYMENT_LINK);
  if (email) {
    url.searchParams.set('prefilled_email', email);
  }
  url.searchParams.set('prefilled_promo_code', PROMO_CODE);
  return url.toString();
}

export default function EarlybirdPage() {
  const { data: user } = useUser();
  const stripeUrl = buildStripeUrl(user?.google_user_email);

  return (
    <PageLayout title="">
      <div className="flex justify-center pt-8">
        <Card className="group border-brand-primary/20 hover:border-brand-primary/40 hover:shadow-brand-primary/5 relative max-w-2xl overflow-hidden transition-all hover:shadow-lg">
          <div className="bg-brand-primary/10 group-hover:bg-brand-primary/20 absolute top-0 right-0 h-40 w-40 translate-x-10 -translate-y-10 rounded-full blur-2xl transition-all" />
          <div className="bg-brand-primary/5 group-hover:bg-brand-primary/10 absolute bottom-0 left-0 h-32 w-32 -translate-x-8 translate-y-8 rounded-full blur-2xl transition-all" />

          <CardHeader className="relative pb-4">
            <div className="flex items-center gap-3">
              <span className="text-3xl" role="img" aria-label="lobster">
                🦞
              </span>
              <CardTitle className="text-2xl">Presale: 50% Off for the First 100</CardTitle>
            </div>
            <span className="bg-brand-primary/15 text-brand-primary mt-2 w-fit rounded-full px-3 py-1 text-xs font-bold tracking-wide uppercase">
              Early Bird &mdash; 50% Off
            </span>
          </CardHeader>

          <CardContent className="relative flex flex-col gap-4">
            <p className="text-muted-foreground leading-relaxed">
              To thank those of you who have been early adopters, we&apos;re offering the first 100
              users 6 months of KiloClaw compute at 50% off. That&apos;s{' '}
              <span className="text-brand-primary font-semibold">$150 total</span> &mdash; works out
              to <span className="text-brand-primary font-semibold">$25/month</span> instead of $49.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              The discount applies to compute only, not inference. At $25/month for a hosted AI
              agent, that&apos;s hard to beat. 🦀
            </p>
          </CardContent>

          <CardFooter className="relative pt-2">
            <Button
              className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary w-full text-black hover:bg-black hover:ring-2"
              size="lg"
              asChild
            >
              <a href={stripeUrl} target="_blank" rel="noopener noreferrer">
                🦞 Get the Early Bird Offer
              </a>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </PageLayout>
  );
}
