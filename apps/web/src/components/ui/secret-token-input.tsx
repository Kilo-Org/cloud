'use client';

import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type SecretTokenInputProps = Omit<
  React.ComponentProps<'input'>,
  'type' | 'autoComplete' | 'autoCorrect' | 'spellCheck' | 'autoCapitalize'
> & {
  /** Visible label for the show/hide toggle (defaults to "Show token"). */
  toggleLabel?: string;
};

/**
 * Masked text input for non-credential secrets like third-party API tokens.
 *
 * Why not `<input type="password">`? Chrome and other browsers treat
 * `type="password"` as a strong signal that the surrounding form is a
 * sign-in form, which triggers the password-save prompt — a poor UX
 * for things that aren't passwords (DoltHub API tokens, OAuth tokens,
 * webhook secrets, etc).
 *
 * Instead, we render `type="text"` with `-webkit-text-security: disc`
 * to mask the contents visually, plus an eye toggle to reveal. The
 * combination of `autoComplete="off"`, `data-1p-ignore`, and a
 * non-credential `name` attribute also tells password managers
 * (1Password, Bitwarden, LastPass) that this isn't a sign-in field.
 *
 * Pair with a real `<form autoComplete="off">` ancestor for belt and
 * braces, but the heuristics above are usually sufficient on their own.
 */
export function SecretTokenInput({
  className,
  toggleLabel = 'Show token',
  id: idProp,
  name,
  ...props
}: SecretTokenInputProps) {
  const [revealed, setRevealed] = useState(false);
  const generatedId = useId();
  const id = idProp ?? generatedId;

  return (
    <div className="relative">
      <Input
        id={id}
        // `type="text"` plus visual masking dodges the password-save
        // prompt while keeping the value readable for the user.
        type="text"
        // Browser/password-manager hints. `autoComplete="off"` alone
        // is sometimes ignored by Chrome; `data-1p-ignore`,
        // `data-lpignore`, and `data-form-type="other"` cover
        // 1Password, LastPass, and Dashlane respectively.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore="true"
        data-lpignore="true"
        data-form-type="other"
        // Avoid `name="password"` / `"token"` style attributes that
        // browsers fingerprint as credentials. Default to a neutral
        // name when the caller doesn't override.
        name={name ?? 'secret-value'}
        className={cn(
          // Mask via CSS when not revealed; falls back to plain text
          // in browsers that don't support text-security.
          revealed ? '' : '[-webkit-text-security:disc] [text-security:disc]',
          'pr-10',
          className
        )}
        {...props}
      />
      <button
        type="button"
        aria-label={revealed ? 'Hide token' : toggleLabel}
        aria-pressed={revealed}
        onClick={() => setRevealed(v => !v)}
        className={cn(
          'absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground',
          'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-r-md',
          'disabled:cursor-not-allowed disabled:opacity-50'
        )}
        disabled={props.disabled}
      >
        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
