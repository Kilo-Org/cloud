export function errorMessage(status: string, fallback: string | undefined): string {
  switch (status) {
    case 'expired': {
      return 'Your sign-in code has expired. Please try again.';
    }
    case 'denied': {
      return 'Access was denied.';
    }
    default: {
      return fallback ?? 'Something went wrong. Please try again.';
    }
  }
}
