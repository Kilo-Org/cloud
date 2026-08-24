import { i18n } from '@/i18n';

export function errorMessage(status: string, fallback: string | undefined): string {
  switch (status) {
    case 'expired': {
      return i18n.t('login.signInCodeExpired');
    }
    case 'denied': {
      return i18n.t('login.accessDenied');
    }
    default: {
      return fallback ?? i18n.t('login.somethingWentWrong');
    }
  }
}
