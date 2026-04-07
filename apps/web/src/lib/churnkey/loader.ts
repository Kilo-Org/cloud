'use client';

const CHURNKEY_APP_ID = process.env.NEXT_PUBLIC_CHURNKEY_APP_ID ?? '';
const CHURNKEY_SCRIPT_URL = `https://assets.churnkey.co/js/app.js?appId=${CHURNKEY_APP_ID}`;

type ChurnkeyHandleCancelResult = { message: string };

type ChurnkeyInitOptions = {
  appId: string;
  authHash: string;
  customerId: string;
  subscriptionId: string;
  mode: 'live' | 'test';
  provider: 'stripe';
  record: boolean;
  handleCancel: (customer: string, surveyAnswer: string) => Promise<ChurnkeyHandleCancelResult>;
  onDiscount?: (customer: string, discountInfo: unknown) => void;
  onClose?: () => void;
};

declare global {
  interface Window {
    churnkey?: {
      init: (action: 'show', options: ChurnkeyInitOptions) => void;
      created?: boolean;
    };
  }
}

let scriptLoadPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    if (window.churnkey?.created) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = CHURNKEY_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoadPromise = null;
      reject(new Error('Failed to load Churnkey SDK'));
    };
    document.head.appendChild(script);
  });

  return scriptLoadPromise;
}

export type ShowCancelFlowParams = {
  authHash: string;
  customerId: string;
  stripeSubscriptionId: string;
  onCancel: () => Promise<void>;
  onClose?: () => void;
};

export async function showCancelFlow(params: ShowCancelFlowParams): Promise<void> {
  await loadScript();

  if (!window.churnkey) {
    throw new Error('Churnkey SDK not available');
  }

  const isProd = process.env.NODE_ENV === 'production';

  window.churnkey.init('show', {
    appId: CHURNKEY_APP_ID,
    authHash: params.authHash,
    customerId: params.customerId,
    subscriptionId: params.stripeSubscriptionId,
    mode: isProd ? 'live' : 'test',
    provider: 'stripe',
    record: true,

    handleCancel: (_customer, _surveyAnswer) => {
      return params.onCancel().then(
        (): ChurnkeyHandleCancelResult => ({
          message: "Your subscription has been canceled. You won't be billed again.",
        }),
        () =>
          Promise.reject({
            message: 'Something went wrong. Please try again or contact support.',
          })
      );
    },

    onClose: params.onClose,
  });
}
