import { Mail } from 'lucide-react';

type MagicLinkSentConfirmationProps = {
  email: string;
  onBack?: () => void;
};

/**
 * Displays the "check your email" confirmation after a magic link has been sent.
 */
export function MagicLinkSentConfirmation({ email, onBack }: MagicLinkSentConfirmationProps) {
  return (
    <div className="mx-auto w-full max-w-md space-y-6 text-center">
      <div className="rounded-lg bg-green-950 p-6">
        <Mail className="mx-auto mb-4 h-12 w-12 text-green-400" />
        <h2 className="mb-2 text-xl font-semibold text-green-300">Check your email</h2>
        <p className="text-muted-foreground text-sm">
          We've sent a magic link to <strong>{email}</strong>
        </p>
        <p className="text-muted-foreground mt-2 text-sm">
          Click the link in the email to sign in. The link will expire in 24 hours.
        </p>
      </div>
      {onBack && (
        <button onClick={onBack} className="text-muted-foreground text-sm hover:underline">
          ← Back to sign in
        </button>
      )}
    </div>
  );
}
