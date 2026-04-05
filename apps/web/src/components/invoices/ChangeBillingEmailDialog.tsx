'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Mail } from 'lucide-react';

type ChangeBillingEmailDialogProps = {
  children: React.ReactNode;
};

export function ChangeBillingEmailDialog({ children }: ChangeBillingEmailDialogProps) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setIsLoading(true);
    try {
      const response = await fetch('/api/billing/update-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update billing email');
      }

      setOpen(false);
      toast('Billing email updated successfully!');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Change Billing Email
          </DialogTitle>
          <DialogDescription>
            Update the email address where you receive billing notifications and invoices.
            <br />
            <br />
            <strong>Note:</strong> This will update your billing email in Stripe.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="email">New Billing Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="Enter your new billing email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Updating...' : 'Update Email'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
