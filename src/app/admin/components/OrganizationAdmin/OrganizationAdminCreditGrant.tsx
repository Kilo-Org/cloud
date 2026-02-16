'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DollarSign } from 'lucide-react';
import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useGrantOrganizationCredit } from '@/app/admin/api/organizations/hooks';
import { toast } from 'sonner';

export function OrganizationAdminCreditGrant({ organizationId }: { organizationId: string }) {
  const { data: session } = useSession();
  const grantCreditMutation = useGrantOrganizationCredit();

  const [amount, setAmount] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [expirationDate, setExpirationDate] = useState<string>('');
  const [expiryHours, setExpiryHours] = useState<string>('');
  const [neverExpire, setNeverExpire] = useState(true);

  const parsedAmount = parseFloat(amount);
  const isNegative = parsedAmount < 0;
  const hasExpiration = expirationDate.trim() !== '' || Number(expiryHours) > 0 || neverExpire;
  const isFormValid =
    !isNaN(parsedAmount) &&
    parsedAmount !== 0 &&
    (!isNegative || description.trim().length > 0) &&
    (isNegative || hasExpiration);

  const handleGrantCredit = async () => {
    if (!isFormValid) return;

    try {
      const finalDescription = description.trim()
        ? `${description.trim()} (${session?.user?.name || session?.user?.email || 'Admin'})`
        : undefined;

      const expiry_date = expirationDate ? new Date(expirationDate).toISOString() : null;
      const expiry_hours_val = expiryHours ? parseFloat(expiryHours) : null;

      await grantCreditMutation.mutateAsync({
        organizationId,
        amount_usd: parsedAmount,
        description: finalDescription,
        expiry_date: neverExpire ? null : expiry_date,
        expiry_hours: neverExpire ? null : expiry_hours_val,
      });

      toast.success(`Successfully granted $${amount} credits to organization`);
      setAmount('');
      setDescription('');
      setExpirationDate('');
      setExpiryHours('');
      setNeverExpire(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to grant credit');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-5 w-5" />
          Grant Credits
        </CardTitle>
        <CardDescription>Grant promotional credits to this organization</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={async e => {
            e.preventDefault();
            await handleGrantCredit();
          }}
        >
          <div className="flex flex-row flex-wrap justify-between gap-4">
            <div>
              <Label className="text-muted-foreground text-sm font-medium" htmlFor="org-amount">
                Amount ($) (Required)
              </Label>
              <Input
                type="number"
                placeholder="Enter amount"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                step="0.01"
                id="org-amount"
                required
              />
            </div>
          </div>

          {!isNegative && (
            <div className="grid [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))] gap-4">
              <div>
                <Label
                  className="text-muted-foreground text-sm font-medium"
                  htmlFor="org-expiry-hours"
                >
                  Expiry Hours{!neverExpire ? ' *' : ''}
                </Label>
                <Input
                  type="number"
                  placeholder="Enter hours"
                  value={expiryHours}
                  onChange={e => setExpiryHours(e.target.value)}
                  min="0"
                  step="0.01"
                  id="org-expiry-hours"
                  disabled={neverExpire}
                />
              </div>
              <div>
                <Label
                  className="text-muted-foreground text-sm font-medium"
                  htmlFor="org-expiry-date"
                >
                  Expiration Date{!neverExpire ? ' *' : ''}
                </Label>
                <Input
                  type="date"
                  value={expirationDate}
                  onChange={e => setExpirationDate(e.target.value)}
                  id="org-expiry-date"
                  disabled={neverExpire}
                />
              </div>
              <div className="flex items-end">
                <Label className="flex items-center gap-2 pb-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={neverExpire}
                    onChange={e => {
                      setNeverExpire(e.target.checked);
                      if (e.target.checked) {
                        setExpirationDate('');
                        setExpiryHours('');
                      }
                    }}
                  />
                  Never expire
                </Label>
              </div>
            </div>
          )}

          {!isNegative && !isNaN(parsedAmount) && parsedAmount !== 0 && !hasExpiration && (
            <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
              Please specify an expiration date or expiry hours, or check &quot;Never expire&quot;
              to grant credits without expiration.
            </div>
          )}

          <div>
            <Label className="text-muted-foreground text-sm font-medium" htmlFor="org-description">
              Description {isNegative ? '(Required)' : '(Optional)'}
            </Label>
            <Input
              type="text"
              placeholder={
                isNegative
                  ? 'Enter credit description (required)'
                  : 'Enter credit description (optional)'
              }
              value={description}
              onChange={e => setDescription(e.target.value)}
              id="org-description"
            />
          </div>

          <Button
            disabled={!isFormValid || grantCreditMutation.isPending}
            className="w-full sm:w-auto"
            type="submit"
          >
            {grantCreditMutation.isPending ? 'Granting...' : 'Grant Credit'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
