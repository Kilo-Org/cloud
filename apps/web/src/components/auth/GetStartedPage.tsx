import { AuthPageLayout } from '@/components/auth/AuthPageLayout';
import { SignInForm } from '@/components/auth/SignInForm';
import { allow_fake_login, FIRST_TOPUP_BONUS_AMOUNT } from '@/lib/constants';
import type { SsoAccountMismatch } from '@/lib/auth/sso-account-mismatch';
import { useMemo } from 'react';

type GetStartedPageProps = {
  title: string;
  callbackPath: string;
  searchParams: Record<string, string>;
  error?: string;
  signUpText?: string;
  accountMismatch?: SsoAccountMismatch;
};

export function GetStartedPage({
  title,
  callbackPath,
  searchParams,
  error,
  signUpText,
  accountMismatch,
}: GetStartedPageProps) {
  const searchParamsWithCallback = useMemo(
    () => ({ ...searchParams, callbackPath }),
    [searchParams, callbackPath]
  );

  return (
    <AuthPageLayout>
      <div className="mt-4 flex flex-col items-center">
        <SignInForm
          searchParams={searchParamsWithCallback}
          error={error}
          isSignUp={true}
          allowFakeLogin={allow_fake_login}
          title={title}
          accountMismatch={accountMismatch}
          subtitle={
            signUpText ??
            (FIRST_TOPUP_BONUS_AMOUNT > 0
              ? `After you sign up, you can directly get started with free models, or top up, and get
            another $${FIRST_TOPUP_BONUS_AMOUNT} of AI model usage credits to try the most advanced models.`
              : 'After you sign up, you can directly get started with free models, or top up to try the most advanced AI models.')
          }
        />
      </div>
    </AuthPageLayout>
  );
}
