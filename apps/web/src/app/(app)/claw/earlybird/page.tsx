'use client';

import { PageLayout } from '@/components/PageLayout';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { ClawConfigServiceBannerWithStatus } from '../components/ClawConfigServiceBanner';

export default function EarlybirdPage() {
  return (
    <PageLayout title="">
      <ClawConfigServiceBannerWithStatus className="mx-auto w-full max-w-[1140px]" />
      <div className="flex justify-center pt-8">
        <Card className="group border-brand-primary/20 relative max-w-2xl overflow-hidden">
          <div className="bg-brand-primary/10 absolute top-0 right-0 h-40 w-40 translate-x-10 -translate-y-10 rounded-full blur-2xl" />
          <div className="bg-brand-primary/5 absolute bottom-0 left-0 h-32 w-32 -translate-x-8 translate-y-8 rounded-full blur-2xl" />

          <CardHeader className="relative pb-4">
            <div className="flex items-center gap-3">
              <span className="text-3xl" role="img" aria-label="lobster">
                🦞
              </span>
              <CardTitle className="text-2xl">Early Bird Offer</CardTitle>
            </div>
            <span className="bg-muted text-muted-foreground mt-2 w-fit rounded-full px-3 py-1 text-xs font-bold tracking-wide uppercase">
              Sold Out
            </span>
          </CardHeader>

          <CardContent className="relative flex flex-col gap-4">
            <p className="text-muted-foreground leading-relaxed">
              The early bird offer has ended. All 1,000 spots have been claimed.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Thank you to everyone who participated! If you purchased the early bird deal, your
              discounted hosting is already active on your account.
            </p>
          </CardContent>

          <CardFooter className="relative pt-2">
            <Button variant="outline" size="lg" className="w-full" asChild>
              <Link href="/claw">Back to KiloClaw</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </PageLayout>
  );
}
