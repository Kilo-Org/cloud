'use client';

import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { DollarSign } from 'lucide-react';
import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useQueryClient } from '@tanstack/react-query';
import type { AddCreditRequest, UserDetailProps } from '@/types/admin';
import type { GuiCreditCategory } from '@/lib/PromoCreditCategoryConfig';
import { formatCategoryAsMarkdown } from '@/lib/PromoCreditCategoryConfig';
import ReactMarkdown from 'react-markdown';

interface CreditMessage {
  type: 'success' | 'error';
  text: string;
}

type UserAdminCreditGrantProps = UserDetailProps & {
  promoCreditCategories: readonly GuiCreditCategory[];
};

export function UserAdminCreditGrant({
  id,
  google_user_email,
  promoCreditCategories,
}: UserAdminCreditGrantProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  // Credit form state
  const [selectedCredit, setSelectedCredit] = useState<string>('custom');
  const [showSelfServe, setShowSelfServe] = useState(false);
  const [includeNonSupport, setIncludeNonSupport] = useState(false);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [customDescription, setCustomDescription] = useState<string>('');
  const [expirationDate, setExpirationDate] = useState<string>('');
  const [expiryHours, setExpiryHours] = useState<string>('');
  const [neverExpire, setNeverExpire] = useState(false);

  // API state
  const [isGrantingCredit, setIsGrantingCredit] = useState(false);
  const [creditMessage, setCreditMessage] = useState<CreditMessage | null>(null);

  const selectedCreditCategory = promoCreditCategories.find(
    o => o.credit_category === selectedCredit
  );
  const expectNegative = selectedCreditCategory?.expect_negative_amount ?? false;

  // Check if expiration is provided (either via date, hours, or category default)
  const hasExpirationFromCategory =
    selectedCreditCategory?.expiry_hours != null ||
    selectedCreditCategory?.credit_expiry_date != null;
  const hasExpirationFromForm = expirationDate.trim() !== '' || Number(expiryHours) > 0;
  const hasExpiration = hasExpirationFromCategory || hasExpirationFromForm || neverExpire;

  // Form validation - credit category required; description required for negative amount categories
  // For non-negative amounts, expiration is required unless "Never expire" is checked
  const isExpirationValid = expectNegative || hasExpiration;
  const isFormValid =
    selectedCredit && (!expectNegative || customDescription.trim().length > 0) && isExpirationValid;

  const handleCreditTypeChange = (value: string) => {
    setSelectedCredit(value);
    // Clear all fields - let backend use defaults, show them as placeholders
    setCustomAmount('');
    setCustomDescription('');
    setExpirationDate('');
    setExpiryHours('');
    setNeverExpire(false);
  };

  const handleGrantCredit = async () => {
    const parsedAmount = customAmount ? parseFloat(customAmount) : undefined;
    const isValidAmount =
      parsedAmount === undefined ||
      (Number.isFinite(parsedAmount) && parsedAmount !== 0 && parsedAmount < 0 === expectNegative);
    if (!isValidAmount) {
      return;
    }

    setIsGrantingCredit(true);
    setCreditMessage(null);

    try {
      const requestBody: AddCreditRequest = {
        email: google_user_email,
        amount_usd: customAmount ? parseFloat(customAmount) : undefined,
        description: customDescription.trim()
          ? `${customDescription} (${session?.user?.name || session?.user?.email || 'Admin'})`
          : undefined,
        credit_category: selectedCredit,
        credit_expiry_date: expirationDate,
        expiry_hours: expiryHours ? parseFloat(expiryHours) : undefined,
      };

      const response = await fetch('/admin/api/users/add-credit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const result = await response.json();

      if (response.ok) {
        setCreditMessage({
          type: 'success',
          text: `Successfully added credit transaction to ${google_user_email}${expirationDate ? ` (expires ${expirationDate})` : ''}`,
        });
        setSelectedCredit('');
        setCustomAmount('');
        setCustomDescription('');
        setExpirationDate('');
        setExpiryHours('');
        setNeverExpire(false);
        await queryClient.invalidateQueries({ queryKey: ['admin-user-credit-transactions', id] });
      } else {
        setCreditMessage({
          type: 'error',
          text: result.error || 'Failed to add credit transaction',
        });
      }
    } catch (_error) {
      setCreditMessage({
        type: 'error',
        text: 'Network error occurred while adding credit transaction',
      });
    } finally {
      setIsGrantingCredit(false);
    }
  };

  return (
    <Card className="text-muted-foreground p-6 lg:col-span-2">
      <form
        className="space-y-4"
        onSubmit={async e => {
          e.preventDefault();
          await handleGrantCredit();
        }}
      >
        <div className="flex flex-row flex-wrap justify-between gap-4">
          <div className="flex flex-col gap-2">
            <CardTitle className="text-foreground flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Grant / Decrement Credits
            </CardTitle>
            <div className="flex flex-col gap-2">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={showSelfServe}
                  onChange={e => setShowSelfServe(e.target.checked)}
                />
                Show self-serve categories
              </Label>
              <Label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={includeNonSupport}
                  onChange={e => setIncludeNonSupport(e.target.checked)}
                />
                Include other, non-support categories
              </Label>
            </div>
            <Label className="flex flex-col items-start gap-2 text-sm font-medium">
              Credit Category
              <Select value={selectedCredit} onValueChange={handleCreditTypeChange}>
                <SelectTrigger id="credit-type-select">
                  <SelectValue placeholder="Select category.." />
                </SelectTrigger>
                <SelectContent>
                  {promoCreditCategories
                    .filter(
                      option =>
                        !option.obsolete &&
                        (!option.promotion_ends_at || new Date() < option.promotion_ends_at)
                    )
                    .filter(
                      option =>
                        (showSelfServe || !option.is_user_selfservicable) &&
                        (includeNonSupport ||
                          !!option.adminUI_label ||
                          option.is_user_selfservicable)
                    )
                    .map(option => (
                      <SelectItem key={option.credit_category} value={option.credit_category}>
                        {option.adminUI_label ?? option.credit_category}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Label>
          </div>
          {/* Category Details Section */}
          {selectedCreditCategory && !selectedCreditCategory.adminUI_label && (
            <div className="prose prose-sm prose-invert max-w-none">
              <ReactMarkdown>{formatCategoryAsMarkdown(selectedCreditCategory)}</ReactMarkdown>
            </div>
          )}
        </div>

        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))] gap-4">
          <div>
            <Label className="text-sm font-medium" htmlFor="amount">
              Amount ($){expectNegative ? ' (negative)' : ''}
            </Label>
            <Input
              type="number"
              placeholder={
                selectedCreditCategory?.amount_usd?.toString() ||
                (expectNegative ? 'Enter negative amount' : 'Enter amount')
              }
              value={customAmount}
              onChange={e => setCustomAmount(e.target.value)}
              max={expectNegative ? '-0.01' : undefined}
              min={expectNegative ? undefined : '0.01'}
              step="0.01"
              id="amount"
              disabled={!selectedCredit}
            />
          </div>
          {!expectNegative && (
            <>
              <div>
                <Label className="text-sm font-medium" htmlFor="expiry-hours">
                  Expiry Hours{!hasExpirationFromCategory && !neverExpire ? ' *' : ''}
                </Label>
                <Input
                  type="number"
                  placeholder={selectedCreditCategory?.expiry_hours?.toString() || 'Enter hours'}
                  value={expiryHours}
                  onChange={e => setExpiryHours(e.target.value)}
                  min="0"
                  step="0.01"
                  id="expiry-hours"
                  disabled={!selectedCredit || neverExpire}
                />
              </div>
              <div>
                <Label className="text-sm font-medium" htmlFor="date">
                  Expiration Date{!hasExpirationFromCategory && !neverExpire ? ' *' : ''}
                </Label>
                <Input
                  type="date"
                  value={
                    expirationDate ?? selectedCreditCategory?.credit_expiry_date?.toISOString()
                  }
                  onChange={e => setExpirationDate(e.target.value)}
                  id="date"
                  disabled={!selectedCredit || neverExpire}
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
                    disabled={!selectedCredit}
                  />
                  Never expire
                </Label>
              </div>
            </>
          )}
        </div>

        {!expectNegative && selectedCredit && !isExpirationValid && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
            Please specify an expiration date or expiry hours, or check &quot;Never expire&quot; to
            grant credits without expiration.
          </div>
        )}

        <div className="flex flex-row flex-wrap gap-4">
          <div className="grow">
            <Label className="text-sm font-medium" htmlFor="description">
              Description{expectNegative ? ' (required)' : ''}
            </Label>
            <Input
              type="text"
              placeholder={selectedCreditCategory?.description ?? 'Enter credit description'}
              value={customDescription}
              onChange={e => setCustomDescription(e.target.value)}
              id="description"
              disabled={!selectedCredit}
              required={expectNegative}
            />
          </div>
          <Button
            disabled={!isFormValid || isGrantingCredit}
            className="ml-auto self-end sm:w-auto"
            type="submit"
          >
            {isGrantingCredit ? 'Adjusting Credits...' : 'Add Credit Transaction'}
          </Button>
        </div>

        {creditMessage && (
          <div
            className={`rounded-md p-3 text-sm ${
              creditMessage.type === 'success'
                ? 'border border-green-200 bg-green-50 text-green-800'
                : 'border border-red-200 bg-red-50 text-red-800'
            }`}
          >
            {creditMessage.text}
          </div>
        )}
      </form>
    </Card>
  );
}
