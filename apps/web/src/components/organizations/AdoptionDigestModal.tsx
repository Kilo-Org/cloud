'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useUpdateAdoptionDigest } from '@/app/api/organizations/hooks';

type AdoptionDigestModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  settings: OrganizationSettings | undefined;
};

const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
};

export function AdoptionDigestModal({
  open,
  onOpenChange,
  organizationId,
  settings,
}: AdoptionDigestModalProps) {
  const [emails, setEmails] = useState<string[]>(settings?.adoption_digest_email ?? []);
  const [newEmail, setNewEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);

  const updateAdoptionDigestMutation = useUpdateAdoptionDigest();

  // Sync form state with settings when dialog opens.
  useEffect(() => {
    if (open) {
      setEmails(settings?.adoption_digest_email ?? []);
      setNewEmail('');
      setEmailError(null);
    }
  }, [open, settings]);

  const handleAddEmail = () => {
    const trimmedEmail = newEmail.trim();
    if (!trimmedEmail) {
      return;
    }

    if (!isValidEmail(trimmedEmail)) {
      setEmailError('Please enter a valid email address');
      return;
    }

    if (emails.includes(trimmedEmail)) {
      setEmailError('This email is already in the list');
      return;
    }

    setEmails([...emails, trimmedEmail]);
    setNewEmail('');
    setEmailError(null);
  };

  const handleRemoveEmail = (emailToRemove: string) => {
    setEmails(emails.filter(email => email !== emailToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddEmail();
    }
  };

  const handleSave = () => {
    // An empty recipient list disables the digest; a non-empty list enables it.
    const willBeEnabled = emails.length > 0;

    updateAdoptionDigestMutation.mutate(
      {
        organizationId,
        adoption_digest_email: emails,
      },
      {
        onSuccess: () => {
          toast.success(
            willBeEnabled
              ? `Weekly adoption digest enabled for ${emails.length} recipient${
                  emails.length === 1 ? '' : 's'
                }`
              : 'Weekly adoption digest disabled'
          );
          onOpenChange(false);
        },
        onError: (error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : 'Failed to update adoption digest settings'
          );
        },
      }
    );
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Weekly adoption digest</DialogTitle>
          <DialogDescription>
            Email a weekly summary of adopted features and open recommendations to the addresses
            below. Remove every address to turn the digest off.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="adoptionDigestEmail">Recipients</Label>
            <div className="flex gap-2">
              <Input
                id="adoptionDigestEmail"
                type="email"
                placeholder="email@example.com"
                value={newEmail}
                onChange={e => {
                  setNewEmail(e.target.value);
                  setEmailError(null);
                }}
                onKeyDown={handleKeyDown}
                className={emailError ? 'border-red-500 focus:border-red-500' : ''}
                aria-describedby="adoptionDigestEmailHelp"
              />
              <Button type="button" variant="outline" size="icon" onClick={handleAddEmail}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {emailError && <p className="text-sm text-red-600">{emailError}</p>}

            {emails.length > 0 ? (
              <div className="mt-2 space-y-1">
                {emails.map(email => (
                  <div
                    key={email}
                    className="bg-muted flex items-center justify-between rounded-md px-3 py-2 text-sm"
                  >
                    <span>{email}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveEmail(email)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${email}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p id="adoptionDigestEmailHelp" className="text-muted-foreground text-xs">
                Add at least one address to receive the weekly digest. With no addresses, the digest
                stays off.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={updateAdoptionDigestMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateAdoptionDigestMutation.isPending}>
            {updateAdoptionDigestMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
