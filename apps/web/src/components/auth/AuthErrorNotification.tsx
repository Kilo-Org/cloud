'use client';
import { BlockedNotification } from '@/components/auth/BlockedNotification';

export function AuthErrorNotification({ error }: { error: string }) {
  if (error === 'BLOCKED') return <BlockedNotification />;

  if (error === 'DIFFERENT-OAUTH')
    return (
      <div data-error-notification>
        <ErrorNotificationBox title="Error">
          An account already exists with this email. Did you use a different login method?
        </ErrorNotificationBox>
      </div>
    );

  if (error === 'ACCOUNT-ALREADY-LINKED')
    return (
      <div data-error-notification>
        <ErrorNotificationBox title="Account Already Linked">
          This account is already linked to another user. Please use a different account or contact
          support if you believe this is an error.
        </ErrorNotificationBox>
      </div>
    );

  if (error === 'PROVIDER-ALREADY-LINKED')
    return (
      <div data-error-notification>
        <ErrorNotificationBox title="Provider Already Linked">
          You already have this type of account linked. Please unlink the existing account first.
        </ErrorNotificationBox>
      </div>
    );

  if (error === 'LINKING-FAILED')
    return (
      <div data-error-notification>
        <ErrorNotificationBox title="Account Linking Failed">
          Account linking failed. Please try again or contact support if the problem persists.
        </ErrorNotificationBox>
      </div>
    );

  if (error === 'EMAIL-MUST-BE-LOWERCASE')
    return (
      <div data-error-notification>
        <ErrorNotificationBox title="Invalid Email">
          Email address must be lowercase for new account signup.
        </ErrorNotificationBox>
      </div>
    );

  if (error === 'EMAIL-CANNOT-CONTAIN-PLUS')
    return (
      <div data-error-notification>
        <ErrorNotificationBox title="Invalid Email">
          Email address cannot contain a + character for new account signup.
        </ErrorNotificationBox>
      </div>
    );

  return (
    <div data-error-notification>
      <ErrorNotificationBox title="Error">
        Oops! Something went wrong trying to log in.
      </ErrorNotificationBox>
    </div>
  );
}

function ErrorNotificationBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="relative mx-auto mt-8 mb-8 w-full max-w-sm rounded-lg border-2 border-red-800 bg-red-950/30 p-4">
      <div className="flex items-center">
        <svg className="mr-3 h-5 w-5 text-red-400" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        <h3 className="font-semibold text-red-200">{title}</h3>
      </div>
      <p className="mt-2 text-red-300">{children}</p>
      <button
        className="absolute top-2 right-2 rounded-md p-1 text-red-600 hover:bg-red-900/50 hover:text-red-200"
        onClick={() => {
          // Close the notification by hiding it
          const element = document.querySelector('[data-error-notification]') as HTMLElement;
          if (element) {
            element.style.display = 'none';
          }
        }}
        aria-label="Close notification"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
