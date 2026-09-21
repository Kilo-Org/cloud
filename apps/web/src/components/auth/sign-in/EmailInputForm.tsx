'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import React from 'react';
import { useState } from 'react';

type EmailInputFormProps = {
  email: string;
  emailValidation: { isValid: boolean; error: string | null };
  onSubmit: (e: React.FormEvent) => void;
  onEmailChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  isLoading?: boolean;
  /**
   * The submit label. Surfaces that show this form beside the OAuth provider
   * buttons name the method ('Continue with Email') so the email action reads
   * as a peer of 'Continue with Google' / 'Continue with ChatGPT'; the plain
   * 'Continue' stays the default everywhere else.
   */
  submitLabel?: string;
};

/**
 * Email input form component for sign-in flow.
 * Displays email input, validation errors, and Continue button.
 */
export function EmailInputForm({
  email,
  emailValidation,
  onSubmit,
  onEmailChange,
  placeholder = 'you@example.com',
  autoFocus = false,
  disabled = false,
  isLoading = false,
  submitLabel = 'Continue',
}: EmailInputFormProps) {
  const [hasBlurred, setHasBlurred] = useState(false);
  const validationError =
    hasBlurred && email && !emailValidation.isValid ? emailValidation.error : null;
  const visibleError = validationError;
  const errorId = 'sign-in-email-error';
  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-6">
      <div className="space-y-2">
        <label
          htmlFor="sign-in-email"
          className="text-foreground block text-left text-sm font-medium"
        >
          Email address
        </label>
        <Input
          id="sign-in-email"
          name="email"
          type="email"
          placeholder={placeholder}
          value={email}
          onChange={e => onEmailChange(e.target.value)}
          onBlur={() => setHasBlurred(true)}
          autoComplete="email"
          aria-invalid={Boolean(visibleError)}
          aria-describedby={visibleError ? errorId : undefined}
          className={cn(visibleError ? 'border-destructive' : '', 'pointer-coarse:min-h-11')}
          autoFocus={autoFocus}
        />
        {visibleError && (
          <p id={errorId} role="alert" className="text-left text-sm text-red-400">
            {visibleError}
          </p>
        )}
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="min-h-11 w-full"
        disabled={disabled || isLoading || !email.trim() || !emailValidation.isValid}
      >
        {isLoading ? 'Finding sign-in methods...' : submitLabel}
      </Button>
    </form>
  );
}
