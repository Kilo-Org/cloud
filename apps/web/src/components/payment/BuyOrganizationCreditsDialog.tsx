'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import CreditPurchaseOptions from './CreditPurchaseOptions';
import { OrganizationAutoTopUpToggle } from '@/components/organizations/OrganizationAutoTopUpToggle';
import { RefreshCw } from 'lucide-react';
import { useIsAutoTopUpEnabled } from '@/components/organizations/OrganizationContext';

type BuyOrganizationCreditsDialogProps = {
  organizationId: string;
  amounts?: number[];
  triggerClassName?: string;
  triggerVariant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'link' | 'destructive';
};

const DEFAULT_ORG_AMOUNTS = [100, 500, 1000];

export default function BuyOrganizationCreditsDialog({
  organizationId,
  amounts = DEFAULT_ORG_AMOUNTS,
}: BuyOrganizationCreditsDialogProps) {
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);
  const isAutoTopUpEnabled = useIsAutoTopUpEnabled();

  return (
    <>
      <Dialog open={buyCreditsOpen} onOpenChange={setBuyCreditsOpen}>
        <DialogTrigger asChild>
          <Button className="cursor-pointer whitespace-nowrap" variant="primary">
            Buy More Credits
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Buy Organization Credits</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <CreditPurchaseOptions amounts={amounts} organizationId={organizationId} />
            {isAutoTopUpEnabled && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <RefreshCw className="h-5 w-5" />
                    Automatic Top-Up
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <OrganizationAutoTopUpToggle organizationId={organizationId} />
                </CardContent>
              </Card>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
