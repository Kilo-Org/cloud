'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { DollarSign } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function DevConsumeCreditsButton() {
  const [amount, setAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  if (process.env.NODE_ENV !== 'development') return null;

  const handleConsume = async () => {
    const dollarAmount = parseFloat(amount);
    if (isNaN(dollarAmount) || dollarAmount <= 0) {
      alert('Please enter a valid amount greater than 0');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch('/api/dev/consume-credits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dollarAmount }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to consume credits');
      }

      setAmount('');

      router.refresh();
    } catch (error) {
      console.error('Error consuming credits:', error);
      alert(
        error instanceof Error ? error.message : 'Failed to consume credits. Please try again.'
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
          onChange={e => setAmount(e.target.value)}
          className="max-w-[200px]"
          disabled={isLoading}
        />
        <Button
          type="button"
          variant="secondary"
          size="md"
          className="flex items-center"
          onClick={handleConsume}
          disabled={isLoading || !amount}
        >
          <DollarSign className="mr-2 h-4 w-4" />
          {isLoading ? 'Consuming... (very slow, be patient)' : 'Consume'}
        </Button>
      </div>
    </div>
  );
}
