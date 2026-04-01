import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { LockableContainer } from '../LockableContainer';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Edit, AlertCircle, Plus, Minus } from 'lucide-react';
import {
  useUpdateOrganizationSeatCount,
  useInvalidateAllOrganizationData,
} from '@/app/api/organizations/hooks';
import { useOrganizationSeatUsage } from '@/app/api/organizations/hooks';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import type { Stripe } from '@stripe/stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/constants';

// Cache the Stripe promise to avoid recreating it on each render
let stripePromise: Promise<Stripe | null> | null = null;
function getStripe() {
  if (!stripePromise && STRIPE_PUBLISHABLE_KEY) {
    stripePromise = loadStripe(STRIPE_PUBLISHABLE_KEY);
  }
  return stripePromise;
}

export function SeatChangeModal({
  isOpen,
  onClose,
  currentSeatCount,
  organizationId,
  price,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentSeatCount: number;
  organizationId: string;
  price: number;
}) {
  const [newSeatCount, setNewSeatCount] = useState(currentSeatCount);
  const [inputValue, setInputValue] = useState(currentSeatCount.toString());
  const [validationError, setValidationError] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Use the mutation hook for updating seat count
  const updateSeatCountMutation = useUpdateOrganizationSeatCount();
  const invalidateAllOrgData = useInvalidateAllOrganizationData();

  // Get the current active seat usage (members + invites)
  const seatUsageQuery = useOrganizationSeatUsage(organizationId);
  const activeSeatCount = seatUsageQuery.data?.usedSeats ?? currentSeatCount;

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setNewSeatCount(currentSeatCount);
      setInputValue(currentSeatCount.toString());
      setValidationError(null);
      setPaymentError(null);
    }
  }, [isOpen, currentSeatCount]);

  const validateInput = (
    value: string
  ): { isValid: boolean; error: string | null; count: number | null } => {
    // Allow empty input temporarily
    if (value.trim() === '') {
      return { isValid: false, error: 'Seat count is required', count: null };
    }

    const count = parseInt(value, 10);

    // Check if it's a valid integer
    if (isNaN(count) || !Number.isInteger(Number(value))) {
      return { isValid: false, error: 'Seat count must be a whole number', count: null };
    }

    // Backend requires at least 1 seat (UpdateSeatCountInputSchema min(1))
    const minimumSeats = Math.max(1, activeSeatCount);

    if (count < minimumSeats) {
      return {
        isValid: false,
        error:
          activeSeatCount > 0
            ? `Seat count must be at least ${activeSeatCount} (current active members and invites)`
            : 'Seat count must be at least 1',
        count: null,
      };
    }

    return { isValid: true, error: null, count };
  };

  const handleSeatCountChange = (value: string) => {
    setInputValue(value);

    // Validate on input change and update newSeatCount immediately if valid
    const validation = validateInput(value);
    setValidationError(validation.error);

    // Update newSeatCount immediately if the input is valid
    if (validation.isValid && validation.count !== null) {
      setNewSeatCount(validation.count);
    }
  };

  const handleIncrement = () => {
    const currentValue = parseInt(inputValue, 10);
    if (!isNaN(currentValue)) {
      const newValue = currentValue + 1;
      const newValueString = newValue.toString();
      setInputValue(newValueString);

      // Validate and update seat count immediately
      const validation = validateInput(newValueString);
      if (validation.isValid && validation.count !== null) {
        setNewSeatCount(validation.count);
        setValidationError(null);
      } else {
        setValidationError(validation.error);
      }
    }
  };

  const handleDecrement = () => {
    const currentValue = parseInt(inputValue, 10);
    if (!isNaN(currentValue) && currentValue > Math.max(1, activeSeatCount)) {
      const newValue = currentValue - 1;
      const newValueString = newValue.toString();
      setInputValue(newValueString);

      // Validate and update seat count immediately
      const validation = validateInput(newValueString);
      if (validation.isValid && validation.count !== null) {
        setNewSeatCount(validation.count);
        setValidationError(null);
      } else {
        setValidationError(validation.error);
      }
    }
  };

  const handleInputBlur = () => {
    const validation = validateInput(inputValue);

    if (validation.isValid && validation.count !== null) {
      setNewSeatCount(validation.count);
      setValidationError(null);
    } else {
      setValidationError(validation.error);
    }
  };

  const handleClose = useCallback(() => {
    setNewSeatCount(currentSeatCount);
    setInputValue(currentSeatCount.toString());
    setValidationError(null);
    setPaymentError(null);
    onClose();
  }, [currentSeatCount, onClose]);

  const handleUpdateSeats = async () => {
    if (!isInputValid || !hasChanges) return;

    setPaymentError(null);
    try {
      const result = await updateSeatCountMutation.mutateAsync({
        organizationId,
        newSeatCount,
      });

      // Check if 3DS/SCA authentication is required
      if (result.requiresAction) {
        if (!result.paymentIntentClientSecret) {
          // Backend indicated authentication is required but didn't provide the client secret.
          // This should never happen in practice but we handle it gracefully.
          throw new Error('Payment authentication required but setup failed. Please try again.');
        }
        setIsAuthenticating(true);
        try {
          const stripe = await getStripe();
          if (!stripe) {
            throw new Error('Payment system unavailable. Please try again later.');
          }

          // Use handleNextAction() which works with any payment method type
          // (card, link, etc.) instead of confirmCardPayment() which only works with cards
          const { error: actionError, paymentIntent } = await stripe.handleNextAction({
            clientSecret: result.paymentIntentClientSecret,
          });

          if (actionError) {
            // Authentication failed
            throw new Error(
              actionError.message || 'Payment authentication failed. Please try again.'
            );
          }

          if (paymentIntent?.status === 'succeeded') {
            // Payment succeeded after 3DS - refresh data and close modal
            toast.success('Seats updated successfully!');
            await invalidateAllOrgData();
            handleClose();
          } else if (paymentIntent?.status === 'requires_confirmation') {
            // Payment still needs server-side confirmation - this shouldn't happen
            // in our flow since Stripe subscription invoices auto-confirm
            throw new Error('Payment requires additional confirmation. Please contact support.');
          } else {
            // Payment still not complete
            throw new Error('Payment could not be completed. Please try again.');
          }
        } finally {
          setIsAuthenticating(false);
        }
      } else if (result.success) {
        // No 3DS required, seats updated successfully
        toast.success('Seats updated successfully!');
        await invalidateAllOrgData();
        handleClose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update seat count';
      setPaymentError(message);
      toast.error(message);
    }
  };

  const isLoading =
    updateSeatCountMutation.isPending || seatUsageQuery.isLoading || isAuthenticating;
  const hasChanges = newSeatCount !== currentSeatCount;
  const isInputValid = !validationError && validateInput(inputValue).isValid;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <LockableContainer>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="h-5 w-5" />
              Change Seat Count
            </DialogTitle>
            <DialogDescription>
              Adjust the number of seats for your organization subscription.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Current Seats</label>
              <p className="text-muted-foreground text-sm">{currentSeatCount} seats</p>
            </div>

            {seatUsageQuery.data && (
              <div>
                <label className="text-sm font-medium">Active Usage</label>
                <p className="text-muted-foreground text-sm">
                  {seatUsageQuery.data.usedSeats} of {seatUsageQuery.data.totalSeats} seats in use
                </p>
              </div>
            )}

            <div>
              <label className="text-sm font-medium">New Seat Count</label>
              <div className="mt-1">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDecrement}
                    disabled={isLoading || parseInt(inputValue, 10) <= Math.max(1, activeSeatCount)}
                    className="h-10 w-10 p-0"
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Input
                    type="text"
                    value={inputValue}
                    onChange={e => handleSeatCountChange(e.target.value)}
                    onBlur={handleInputBlur}
                    className={`flex-1 text-center ${validationError ? 'border-red-500 focus:border-red-500' : ''}`}
                    disabled={isLoading}
                    autoFocus={false}
                    placeholder="Enter seat count"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleIncrement}
                    disabled={isLoading}
                    className="h-10 w-10 p-0"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {validationError && (
                  <div className="mt-1 flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4" />
                    <span>{validationError}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Manual Preview Section */}
            {isInputValid && (
              <div className="bg-muted/50 rounded-lg border p-3">
                <h4 className="mb-2 text-sm font-medium">Cost Preview</h4>
                <div className="space-y-2 text-sm">
                  {newSeatCount === currentSeatCount ? (
                    <div className="text-muted-foreground">No changes to seat count.</div>
                  ) : newSeatCount > currentSeatCount ? (
                    <>
                      <div className="flex justify-between">
                        <span>Current monthly cost:</span>
                        <span>${(currentSeatCount * price).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between font-medium">
                        <span>New monthly cost:</span>
                        <span>${(newSeatCount * price).toLocaleString()}</span>
                      </div>
                      <div className="mt-2 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800">
                        <strong>Note:</strong> New seats will be granted, and you will be billed a
                        prorated amount the for the additional {newSeatCount - currentSeatCount}{' '}
                        seat
                        {newSeatCount - currentSeatCount > 1 ? 's' : ''} immediately.
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between">
                        <span>Current monthly cost:</span>
                        <span>${(currentSeatCount * price).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between font-medium">
                        <span>New monthly cost:</span>
                        <span>${(newSeatCount * price).toLocaleString()}</span>
                      </div>
                      <Alert variant="warning">
                        <AlertDescription className="inline">
                          <strong>Note:</strong> Your current seat count will not be adjusted until
                          the end of the current billing cycle. No proration will occur.
                        </AlertDescription>
                      </Alert>
                    </>
                  )}
                </div>
              </div>
            )}

            {paymentError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <p className="font-medium">{paymentError}</p>
                  <p className="mt-1 text-sm">
                    Please update your payment method in the subscription settings and try again.
                  </p>
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdateSeats}
              disabled={!hasChanges || !isInputValid || isLoading}
            >
              {isAuthenticating
                ? 'Verifying payment...'
                : updateSeatCountMutation.isPending
                  ? 'Updating...'
                  : 'Update Seats'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </LockableContainer>
    </Dialog>
  );
}
