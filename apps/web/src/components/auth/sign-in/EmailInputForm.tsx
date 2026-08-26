'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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
          className={visibleError ? 'border-destructive' : ''}
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
        {isLoading ? 'Finding sign-in methods...' : 'Continue'}
      </Button>
    </form>
  );
}
