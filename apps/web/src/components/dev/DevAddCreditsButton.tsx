'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function DevAddCreditsButton() {
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  if (process.env.NODE_ENV !== 'development') return null;

  const handleAdd = async () => {
    const dollarAmount = parseFloat(amount);
    if (isNaN(dollarAmount) || dollarAmount <= 0) {
      setAmountError('Enter an amount greater than 0.');
      return;
    }
    setAmountError(null);

    setIsLoading(true);
    try {
      const response = await fetch('/api/dev/add-credits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dollarAmount }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to add credits');
      }

      setAmount('');

      router.refresh();
    } catch (error) {
      console.error('Error adding credits:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to add credits. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          type="number"
          step="0.01"
          min="0"
          placeholder="Amount in dollars"
          value={amount}
          onChange={e => {
            setAmount(e.target.value);
            if (amountError) setAmountError(null);
          }}
          className="max-w-[200px]"
          disabled={isLoading}
          aria-invalid={amountError !== null}
          aria-describedby={amountError ? 'dev-add-amount-error' : undefined}
        />
        <Button
          type="button"
          variant="secondary"
          size="md"
          className="flex items-center"
          onClick={handleAdd}
          disabled={isLoading || !amount}
        >
          <Plus className="mr-2 h-4 w-4" />
          {isLoading ? 'Adding...' : 'Add'}
        </Button>
      </div>
      {amountError && (
        <p id="dev-add-amount-error" className="text-destructive text-xs">
          {amountError}
        </p>
      )}
    </div>
  );
}
