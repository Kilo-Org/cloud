'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

type EmailInputFormProps = {
  email: string;
  emailValidation: { isValid: boolean; error: string | null };
  error?: string;
  onSubmit: (e: React.FormEvent) => void;
  onEmailChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
};

/**
 * Email input form component for sign-in flow.
 * Displays email input, validation errors, and Continue button.
 */
export function EmailInputForm({
  email,
  emailValidation,
  error,
  onSubmit,
  onEmailChange,
  placeholder = 'you@example.com',
  autoFocus = false,
  disabled = false,
}: EmailInputFormProps) {
  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-6">
      <div className="space-y-2">
        <Input
          type="email"
          placeholder={placeholder}
          value={email}
          onChange={e => onEmailChange(e.target.value)}
          className={error || (email && !emailValidation.isValid) ? 'border-destructive' : ''}
          autoFocus={autoFocus}
        />
        {email && !emailValidation.isValid && emailValidation.error && (
          <p className="text-sm text-red-400">{emailValidation.error}</p>
        )}
        {error && !email && <p className="text-sm text-red-400">{error}</p>}
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        disabled={disabled || !email.trim() || !emailValidation.isValid}
      >
        Continue
      </Button>
    </form>
  );
}
