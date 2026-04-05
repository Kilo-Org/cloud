'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/Button';
import { Lock, Eye, EyeOff, Loader2, Shield } from 'lucide-react';

export type PasswordFormState = {
  password: string;
  confirmPassword: string;
  enabled: boolean;
};

type PasswordProtectionProps = {
  /** Current form state */
  value: PasswordFormState;
  /** Called when form state changes */
  onChange: (value: PasswordFormState) => void;
  /** Disable all inputs */
  disabled?: boolean;
  /** Is this an existing deployment that already has password protection enabled? */
  isExistingProtection?: boolean;
  /** Called when protection is being disabled (for existing deployments, triggers confirmation) */
  onDisable?: () => void;
  /** Show loading state for save button */
  isSaving?: boolean;
  /** Called when save/enable button is clicked */
  onSave?: () => void;
  /** Whether to show the save button */
  showSaveButton?: boolean;
  /** Custom save button text */
  saveButtonText?: string;
};

export function PasswordProtection({
  value,
  onChange,
  disabled = false,
  isExistingProtection = false,
  onDisable,
  isSaving = false,
  onSave,
  showSaveButton = false,
  saveButtonText,
}: PasswordProtectionProps) {
  const [showPassword, setShowPassword] = useState(false);

  const handleToggle = (checked: boolean) => {
    if (!checked && isExistingProtection && onDisable) {
      // For existing deployments, turning off triggers confirmation flow
      onDisable();
    } else {
      onChange({ ...value, enabled: checked });
    }
  };

  const handlePasswordChange = (password: string) => {
    onChange({ ...value, password });
  };

  const handleConfirmPasswordChange = (confirmPassword: string) => {
    onChange({ ...value, confirmPassword });
  };

  const buttonText =
    saveButtonText ?? (isExistingProtection ? 'Update Password' : 'Enable Protection');

  return (
    <div className="space-y-4">
      {/* Header with toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-100">Password Protection</h3>
          <p className="mt-1 text-xs text-gray-500">
            Protect your deployment with a password. Visitors will need to enter the password to
            access your site.
          </p>
        </div>
        <Switch
          checked={value.enabled}
          onCheckedChange={handleToggle}
          disabled={disabled}
          aria-label="Enable password protection"
        />
      </div>

      {/* Password fields (shown when enabled) */}
      {value.enabled && (
        <div className="space-y-4 rounded-md border border-gray-700 bg-gray-800/30 p-4">
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Lock className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-500" />
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={value.password}
                onChange={e => handlePasswordChange(e.target.value)}
                placeholder="Enter password"
                disabled={disabled || isSaving}
                className="pr-10 pl-10"
                autoComplete="new-password"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword(!showPassword)}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-gray-500 hover:text-gray-400"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-gray-500">Minimum 8 characters</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm Password</Label>
            <div className="relative">
              <Lock className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-500" />
              <Input
                id="confirm-password"
                type={showPassword ? 'text' : 'password'}
                value={value.confirmPassword}
                onChange={e => handleConfirmPasswordChange(e.target.value)}
                placeholder="Confirm password"
                disabled={disabled || isSaving}
                className="pr-10 pl-10"
                autoComplete="new-password"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword(!showPassword)}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-gray-500 hover:text-gray-400"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {showSaveButton && onSave && (
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={onSave}
                disabled={disabled || isSaving || !value.password || !value.confirmPassword}
                className="gap-1.5"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {isExistingProtection ? 'Updating...' : 'Enabling...'}
                  </>
                ) : (
                  <>
                    <Shield className="size-4" />
                    {buttonText}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function validatePasswordForm(
  value: PasswordFormState
): { valid: true } | { valid: false; error: string } {
  if (!value.enabled) {
    return { valid: true };
  }

  if (!value.password) {
    return { valid: false, error: 'Password cannot be empty' };
  }

  if (value.password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  if (value.password !== value.confirmPassword) {
    return { valid: false, error: 'Passwords do not match' };
  }

  return { valid: true };
}

// Re-export for backwards compatibility
export { PasswordProtection as PasswordFormFields };
