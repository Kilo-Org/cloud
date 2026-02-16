'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

type EditProfileDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkedinUrl: string | null;
  githubUrl: string | null;
};

function isValidUrlOrEmpty(value: string): boolean {
  if (value.trim() === '') return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function EditProfileDialog({
  open,
  onOpenChange,
  linkedinUrl,
  githubUrl,
}: EditProfileDialogProps) {
  const router = useRouter();
  const trpc = useTRPC();

  const [linkedinValue, setLinkedinValue] = useState(linkedinUrl ?? '');
  const [githubValue, setGithubValue] = useState(githubUrl ?? '');
  const [linkedinError, setLinkedinError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);

  // Reset form state when dialog opens
  useEffect(() => {
    if (open) {
      setLinkedinValue(linkedinUrl ?? '');
      setGithubValue(githubUrl ?? '');
      setLinkedinError(null);
      setGithubError(null);
    }
  }, [open, linkedinUrl, githubUrl]);

  const updateProfileMutation = useMutation(
    trpc.user.updateProfile.mutationOptions({
      onSuccess: () => {
        onOpenChange(false);
        router.refresh();
      },
    })
  );

  function handleSave() {
    const trimmedLinkedin = linkedinValue.trim();
    const trimmedGithub = githubValue.trim();

    let hasError = false;

    if (trimmedLinkedin !== '' && !isValidUrlOrEmpty(trimmedLinkedin)) {
      setLinkedinError('Please enter a valid URL');
      hasError = true;
    } else {
      setLinkedinError(null);
    }

    if (trimmedGithub !== '' && !isValidUrlOrEmpty(trimmedGithub)) {
      setGithubError('Please enter a valid URL');
      hasError = true;
    } else {
      setGithubError(null);
    }

    if (hasError) return;

    updateProfileMutation.mutate({
      linkedin_url: trimmedLinkedin === '' ? null : trimmedLinkedin,
      github_url: trimmedGithub === '' ? null : trimmedGithub,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="linkedin-url">LinkedIn Profile URL</Label>
            <Input
              id="linkedin-url"
              placeholder="https://linkedin.com/in/yourprofile"
              value={linkedinValue}
              onChange={e => {
                setLinkedinValue(e.target.value);
                setLinkedinError(null);
              }}
              aria-invalid={linkedinError !== null}
            />
            {linkedinError && <p className="text-destructive text-sm">{linkedinError}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="github-url">GitHub Profile URL</Label>
            <Input
              id="github-url"
              placeholder="https://github.com/yourusername"
              value={githubValue}
              onChange={e => {
                setGithubValue(e.target.value);
                setGithubError(null);
              }}
              aria-invalid={githubError !== null}
            />
            {githubError && <p className="text-destructive text-sm">{githubError}</p>}
          </div>
          {updateProfileMutation.error && (
            <p className="text-destructive text-sm">Failed to save profile. Please try again.</p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateProfileMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateProfileMutation.isPending}>
            {updateProfileMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
