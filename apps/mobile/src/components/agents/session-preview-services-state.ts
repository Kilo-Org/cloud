import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

/** What one sandbox service scan answers. */
type PreviewServices = inferRouterOutputs<MobileRouter>['cloudAgentNext']['listPreviewServices'];
type PreviewServicesStatus = PreviewServices['status'];
export type PreviewService = PreviewServices['services'][number];
export type PreviewUnavailableStatus = Exclude<PreviewServicesStatus, 'running'>;

/** One state the preview sheet paints. */
export type PreviewState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'unavailable'; status: PreviewUnavailableStatus }
  | { kind: 'empty' }
  | { kind: 'services'; services: PreviewService[] };

/**
 * Pick the state a sandbox service scan is in from its own readings. The tRPC
 * `queryOptions` result is typed as a settled success, so this selector takes
 * the same fields through the honest view (a promise that may still be pending,
 * a scan that may have failed). It is pure, so the stopped, not-ready and
 * unsupported answers are covered without a device.
 */
export function selectPreviewState(query: {
  data: PreviewServices | undefined;
  isError: boolean;
  isPending: boolean;
}): PreviewState {
  if (query.isPending) {
    return { kind: 'loading' };
  }
  if (query.isError || query.data === undefined) {
    return { kind: 'failed' };
  }
  const { status } = query.data;
  if (status !== 'running') {
    return { kind: 'unavailable', status };
  }
  if (query.data.services.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'services', services: query.data.services };
}
