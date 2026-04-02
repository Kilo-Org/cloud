'use client';

import { useState } from 'react';
import { Check, Loader2, Monitor, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import {
  useClawPairing,
  useClawDevicePairing,
  useClawRefreshPairing,
  useClawRefreshDevicePairing,
} from '../hooks/useClawHooks';
import { Button } from '@/components/ui/button';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

type NormalizedRequest =
  | { kind: 'channel'; key: string; channel: string; code: string; id: string }
  | {
      kind: 'device';
      key: string;
      requestId: string;
      deviceId: string;
      role?: string;
      platform?: string;
    };

export function PairingSection({ mutations }: { mutations: ClawMutations }) {
  const {
    data: channelPairing,
    isLoading: channelLoading,
    isFetching: channelFetching,
  } = useClawPairing(true);
  const {
    data: devicePairing,
    isLoading: deviceLoading,
    isFetching: deviceFetching,
  } = useClawDevicePairing(true);
  const refreshChannelPairing = useClawRefreshPairing();
  const refreshDevicePairingFn = useClawRefreshDevicePairing();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const isLoading = channelLoading || deviceLoading;
  const spinning = isRefreshing || channelFetching || deviceFetching;

  const isChannelApproving = mutations.approvePairingRequest.isPending;
  const isDeviceApproving = mutations.approveDevicePairingRequest.isPending;
  const isApproving = isChannelApproving || isDeviceApproving;

  const requests: NormalizedRequest[] = [];
  for (const req of channelPairing?.requests ?? []) {
    requests.push({
      kind: 'channel',
      key: `channel:${req.channel}:${req.code}`,
      channel: req.channel,
      code: req.code,
      id: req.id,
    });
  }
  for (const req of devicePairing?.requests ?? []) {
    requests.push({
      kind: 'device',
      key: `device:${req.requestId}`,
      requestId: req.requestId,
      deviceId: req.deviceId,
      role: req.role,
      platform: req.platform,
    });
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await Promise.all([refreshChannelPairing(), refreshDevicePairingFn()]);
    } catch {
      toast.error('Failed to refresh pairing requests');
    } finally {
      setIsRefreshing(false);
    }
  }

  function handleApproveChannel(channel: string, code: string) {
    mutations.approvePairingRequest.mutate(
      { channel, code },
      {
        onSuccess: result => {
          if (result.success) {
            toast.success('Channel pairing approved');
          } else {
            toast.error(result.message || 'Approval failed');
          }
        },
        onError: err => toast.error(`Failed to approve: ${err.message}`),
      }
    );
  }

  function handleApproveDevice(requestId: string) {
    mutations.approveDevicePairingRequest.mutate(
      { requestId },
      {
        onSuccess: result => {
          if (result.success) {
            toast.success('Device pairing approved');
          } else {
            toast.error(result.message || 'Approval failed');
          }
        },
        onError: err => toast.error(`Failed to approve: ${err.message}`),
      }
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-foreground flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4 w-4" />
          Pairing Requests
        </h2>
        <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
          <RefreshCw className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {requests.length > 0 ? (
        <div className="divide-y rounded-md border">
          {requests.map(request =>
            request.kind === 'channel' ? (
              <div key={request.key} className="flex items-center justify-between px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                      {request.code}
                    </span>
                    <span className="text-muted-foreground text-xs capitalize">
                      {request.channel}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">User {request.id}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleApproveChannel(request.channel, request.code)}
                  disabled={isApproving}
                >
                  <Check className="h-3 w-3" />
                  Approve
                </Button>
              </div>
            ) : (
              <div key={request.key} className="flex items-center justify-between px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Monitor className="text-muted-foreground h-3.5 w-3.5" />
                    <span className="text-muted-foreground text-xs">
                      {request.role ?? 'device'}
                    </span>
                    {request.platform && (
                      <span className="text-muted-foreground text-xs">({request.platform})</span>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                    {request.deviceId.slice(0, 12)}...
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleApproveDevice(request.requestId)}
                  disabled={isApproving}
                >
                  <Check className="h-3 w-3" />
                  Approve
                </Button>
              </div>
            )
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No pending pairing requests.</p>
      )}
    </div>
  );
}
