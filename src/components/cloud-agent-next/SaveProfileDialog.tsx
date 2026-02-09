/**
 * SaveProfileDialog - Dialog to save current session config as a new profile
 *
 * Captures profile name, description, and whether to set as default.
 * Accepts current envVars and setupCommands to save with the profile.
 */

'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useProfileMutations } from '@/hooks/useCloudAgentProfiles';

const profileFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  description: z.string().max(500, 'Description too long').optional(),
  setAsDefault: z.boolean(),
});

type ProfileFormData = z.infer<typeof profileFormSchema>;

type EnvVar = {
  key: string;
  value: string;
  isSecret?: boolean;
};

type SaveProfileDialogProps = {
  organizationId?: string;
  envVars?: EnvVar[];
  setupCommands?: string[];
  trigger?: React.ReactNode;
  onSaved?: (profileId: string) => void;
};

export function SaveProfileDialog({
  organizationId,
  envVars = [],
  setupCommands = [],
  trigger,
  onSaved,
}: SaveProfileDialogProps) {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState<ProfileFormData>({
    name: '',
    description: '',
    setAsDefault: false,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof ProfileFormData, string>>>({});
  const [isSaving, setIsSaving] = useState(false);

  const {
    createProfile,
    setVar,
    setCommands,
    setAsDefault: setDefaultMutation,
  } = useProfileMutations({
    organizationId,
  });

  const resetForm = () => {
    setFormData({ name: '', description: '', setAsDefault: false });
    setErrors({});
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      resetForm();
    }
  };

  const validate = (): boolean => {
    const result = profileFormSchema.safeParse(formData);
    if (!result.success) {
      const fieldErrors: Partial<Record<keyof ProfileFormData, string>> = {};
      result.error.issues.forEach(issue => {
        if (issue.path[0]) {
          fieldErrors[issue.path[0] as keyof ProfileFormData] = issue.message;
        }
      });
      setErrors(fieldErrors);
      return false;
    }
    setErrors({});
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setIsSaving(true);
    try {
      // 1. Create the profile
      const { id: profileId } = await createProfile.mutateAsync({
        name: formData.name,
        description: formData.description || undefined,
        organizationId,
      });

      // 2. Set all environment variables (including secrets) in parallel
      await Promise.all(
        envVars.map(envVar =>
          setVar.mutateAsync({
            profileId,
            key: envVar.key,
            value: envVar.value,
            isSecret: envVar.isSecret ?? false,
            organizationId,
          })
        )
      );

      // 3. Set commands if any
      if (setupCommands.length > 0) {
        await setCommands.mutateAsync({
          profileId,
          commands: setupCommands,
          organizationId,
        });
      }

      // 4. Set as default if requested
      if (formData.setAsDefault) {
        await setDefaultMutation.mutateAsync({
          profileId,
          organizationId,
        });
      }

      toast.success(`Profile "${formData.name}" saved successfully`);
      setOpen(false);
      resetForm();
      onSaved?.(profileId);
    } catch (error) {
      console.error('Failed to save profile:', error);
      toast.error('Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Save className="mr-2 h-4 w-4" />
            Save as Profile
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Save as Profile</DialogTitle>
          <DialogDescription>
            Save the current environment variables and setup commands as a reusable profile.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="profileName">Profile Name *</Label>
            <Input
              id="profileName"
              value={formData.name}
              onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="My AWS Profile"
              aria-invalid={!!errors.name}
            />
            {errors.name && <p className="text-destructive text-sm">{errors.name}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="profileDescription">Description</Label>
            <Textarea
              id="profileDescription"
              value={formData.description}
              onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Optional description for this profile..."
              rows={3}
              aria-invalid={!!errors.description}
            />
            {errors.description && <p className="text-destructive text-sm">{errors.description}</p>}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="setAsDefault"
              checked={formData.setAsDefault}
              onCheckedChange={checked =>
                setFormData(prev => ({ ...prev, setAsDefault: checked === true }))
              }
            />
            <Label htmlFor="setAsDefault" className="cursor-pointer">
              Set as default profile
            </Label>
          </div>

          {/* Summary of what will be saved */}
          <div className="bg-muted rounded-md p-3 text-sm">
            <p className="font-medium">This profile will include:</p>
            <ul className="text-muted-foreground mt-1 list-inside list-disc">
              <li>
                {envVars.length} environment variable{envVars.length !== 1 ? 's' : ''}
              </li>
              <li>
                {setupCommands.length} setup command{setupCommands.length !== 1 ? 's' : ''}
              </li>
            </ul>
            {envVars.some(v => v.isSecret) && (
              <p className="text-muted-foreground mt-2 text-xs">
                ⚠️ Secrets will be encrypted before storage.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save Profile
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
