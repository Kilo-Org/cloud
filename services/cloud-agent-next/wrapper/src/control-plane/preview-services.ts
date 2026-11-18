import type {
  ControlPlanePreviewListFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  PreviewServicesScanSchema,
  type PreviewService,
} from '../../../src/shared/preview-services.js';
import {
  PREVIEW_SCAN_TIMEOUT_MS,
  PreviewServiceScanTimeoutError,
  scanPreviewServices,
  type PreviewServiceScanOptions,
} from '../control/preview-services.js';

/**
 * Handles the Sandbox DO's preview discovery request in the control-plane
 * wrapper. The wrapper owns the `/proc` scan; the Sandbox DO owns route and
 * allocation state. A scan failure is reported as an error result, never as an
 * empty service list, so the Worker can show the difference.
 */

/** Bound on one discovery reply, below the Sandbox DO's control request budget. */
export const PREVIEW_SERVICES_REQUEST_TIMEOUT_MS = 5_000;

export type ControlPlanePreviewServicesDeps = {
  emit: (frame: ControlPlaneWrapperFrame) => void;
  scan?: (options: PreviewServiceScanOptions) => Promise<PreviewService[]>;
  procRoot?: string;
  excludedPorts?: readonly number[];
  timeoutMs?: number;
  deadlineMs?: number;
  log?: (message: string) => void;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createControlPlanePreviewServices(deps: ControlPlanePreviewServicesDeps): {
  handle(frame: ControlPlanePreviewListFrame): Promise<void>;
} {
  const scan = deps.scan ?? scanPreviewServices;
  const timeoutMs = deps.timeoutMs ?? PREVIEW_SERVICES_REQUEST_TIMEOUT_MS;

  function fail(
    requestId: string,
    code: string,
    message: string,
    retryable: boolean
  ): ControlPlaneWrapperFrame {
    return { type: 'preview.result', requestId, ok: false, error: { code, message, retryable } };
  }

  async function handle(frame: ControlPlanePreviewListFrame): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const services = await scan({
        ...(deps.procRoot === undefined ? {} : { procRoot: deps.procRoot }),
        ...(deps.excludedPorts === undefined ? {} : { excludedPorts: deps.excludedPorts }),
        deadlineMs: deps.deadlineMs ?? PREVIEW_SCAN_TIMEOUT_MS,
        signal: controller.signal,
      });
      const parsed = PreviewServicesScanSchema.safeParse({ services });
      if (!parsed.success) {
        deps.log?.('preview service scan returned an invalid result');
        deps.emit(fail(frame.requestId, 'scan_failed', 'Preview service discovery failed', true));
        return;
      }
      deps.emit({
        type: 'preview.result',
        requestId: frame.requestId,
        ok: true,
        result: parsed.data,
      });
    } catch (error) {
      if (controller.signal.aborted || error instanceof PreviewServiceScanTimeoutError) {
        deps.emit(fail(frame.requestId, 'timeout', 'Preview service discovery timed out', true));
        return;
      }
      deps.log?.(`preview service scan failed: ${messageOf(error)}`);
      deps.emit(fail(frame.requestId, 'scan_failed', 'Preview service discovery failed', true));
    } finally {
      clearTimeout(timer);
    }
  }

  return { handle };
}
