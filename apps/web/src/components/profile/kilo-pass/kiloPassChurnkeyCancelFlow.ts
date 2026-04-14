import type { ShowCancelFlowParams } from '@/lib/churnkey/loader';

const FALLBACK_CANCEL_CONFIRM_MESSAGE =
  'Are you sure you want to cancel your Kilo Pass subscription?';

export type KiloPassChurnkeyAuth = {
  hash: string;
  customerId: string;
};

type MaybePromise<T> = T | Promise<T>;

export type OpenKiloPassChurnkeyCancelFlowParams = {
  stripeSubscriptionId: string;
  getChurnkeyAuthHash: () => Promise<KiloPassChurnkeyAuth>;
  showCancelFlow: (params: ShowCancelFlowParams) => Promise<void>;
  cancelSubscription: () => Promise<unknown>;
  invalidateKiloPassState: () => MaybePromise<unknown>;
  invalidateKiloPassScheduledChange: () => MaybePromise<unknown>;
  fallbackCancelSubscription: () => void;
  confirmFallbackCancel: (message: string) => boolean;
  notifyCancellationScheduled: () => void;
  notifyError: (message: string) => void;
  onBeforeOpen?: () => void;
  onInFlightChange?: (isInFlight: boolean) => void;
};

export function createKiloPassChurnkeyCancelFlow() {
  let isInFlight = false;

  const setIsInFlight = (
    value: boolean,
    params: Pick<OpenKiloPassChurnkeyCancelFlowParams, 'onInFlightChange'>
  ) => {
    isInFlight = value;
    params.onInFlightChange?.(value);
  };

  const invalidateKiloPassQueries = (params: OpenKiloPassChurnkeyCancelFlowParams) =>
    Promise.all([params.invalidateKiloPassState(), params.invalidateKiloPassScheduledChange()]);

  return {
    getIsInFlight: () => isInFlight,

    openCancelFlow: async (params: OpenKiloPassChurnkeyCancelFlowParams): Promise<void> => {
      if (isInFlight) return;

      setIsInFlight(true, params);

      try {
        const { hash, customerId } = await params.getChurnkeyAuthHash();
        params.onBeforeOpen?.();

        let didInvalidateAfterFailedCancellation = false;
        let cancellationPromise: Promise<void> | null = null;

        const invalidateAfterFailedCancellation = () => {
          if (didInvalidateAfterFailedCancellation) return;
          didInvalidateAfterFailedCancellation = true;
          void invalidateKiloPassQueries(params);
        };

        await params.showCancelFlow({
          authHash: hash,
          customerId,
          stripeSubscriptionId: params.stripeSubscriptionId,
          onCancel: async () => {
            const runCancellation = async () => {
              await params.cancelSubscription();
              params.notifyCancellationScheduled();
              await invalidateKiloPassQueries(params);
            };

            cancellationPromise = runCancellation().catch(error => {
              invalidateAfterFailedCancellation();
              throw error;
            });

            await cancellationPromise;
          },
          onClose: () => {
            if (!cancellationPromise) {
              void invalidateKiloPassQueries(params);
            } else {
              void cancellationPromise.catch(() => undefined);
            }
            setIsInFlight(false, params);
          },
        });
      } catch (error) {
        setIsInFlight(false, params);

        const message = error instanceof Error ? error.message : 'Failed to open cancel flow';
        params.notifyError(message);

        if (params.confirmFallbackCancel(FALLBACK_CANCEL_CONFIRM_MESSAGE)) {
          params.fallbackCancelSubscription();
        }
      }
    },
  };
}
