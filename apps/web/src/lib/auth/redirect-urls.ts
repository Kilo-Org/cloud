import {
  knownSignupStepUpMethods,
  SSO_SIGNIN_PATH,
  type AuthErrorType,
  type SignupStepUpMethod,
} from '@kilocode/web-shared/lib/auth/constants';

/** The sign-in query parameter that carries a signup step-up's methods, comma-separated. */
export const SIGNUP_STEP_UP_METHODS_PARAM = 'methods';

export function authFailureRedirectUrl(
  error: AuthErrorType,
  isAccountLinking: boolean,
  stepUpMethods: readonly SignupStepUpMethod[] = []
): string {
  const baseUrl = isAccountLinking ? '/connected-accounts' : '/users/sign_in';
  const params = new URLSearchParams({ error });
  if (stepUpMethods.length > 0) {
    params.set(SIGNUP_STEP_UP_METHODS_PARAM, stepUpMethods.join(','));
  }
  return `${baseUrl}?${params.toString()}`;
}

/** The known step-up methods in an untrusted `methods` query value, in display order. */
export function parseSignupStepUpMethodsParam(value: string | undefined): SignupStepUpMethod[] {
  return value ? knownSignupStepUpMethods(value.split(',')) : [];
}

export function ssoSignInRedirectUrl(domain: string): string {
  return `${SSO_SIGNIN_PATH}?${new URLSearchParams({ domain }).toString()}`;
}
