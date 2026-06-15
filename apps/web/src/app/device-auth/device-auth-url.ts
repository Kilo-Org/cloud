import { cn } from '@/lib/utils';

type AppModeOption = {
  app?: boolean;
};

export function buildDeviceAuthPath(code: string, options: AppModeOption = {}): string {
  const params = new URLSearchParams({ code });
  if (options.app) {
    params.set('app', '1');
  }
  return `/device-auth?${params.toString()}`;
}

export function buildDeviceAuthVerificationUrl(
  appUrl: string,
  code: string,
  options: AppModeOption = {}
): string {
  return `${appUrl}${buildDeviceAuthPath(code, options)}`;
}

export function getDeviceAuthSignInUrl(code: string, options: AppModeOption = {}): string {
  const callbackPath = buildDeviceAuthPath(code, options);
  return `/users/sign_in?${new URLSearchParams({ callbackPath }).toString()}`;
}

export function isDeviceAuthAppMode(value: string | string[] | undefined): boolean {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized === '1' || normalized === 'true';
}

export function getDeviceAuthAppModeFromRequestUrl(requestUrl: string): boolean {
  return isDeviceAuthAppMode(new URL(requestUrl).searchParams.get('app') ?? undefined);
}

export function getDeviceAuthShellClassName(isAppMode: boolean): string {
  return cn(
    'bg-background flex items-center justify-center',
    isAppMode ? 'h-dvh w-full px-4 py-0' : 'min-h-screen p-4'
  );
}

export function getDeviceAuthOutcomeHeaderClassName(): string {
  return 'px-6 py-8 text-center sm:px-8 sm:py-10';
}

export function closeDeviceAuthWindowIfAppMode(
  isAppMode: boolean,
  closeWindow: () => void = () => {
    if (typeof window !== 'undefined') {
      window.close();
    }
  }
): void {
  if (!isAppMode) {
    return;
  }

  closeWindow();
}
