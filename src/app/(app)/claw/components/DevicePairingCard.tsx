'use client';

import { useState } from 'react';
import { Check, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useKiloClawPairing, useRefreshPairing } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function DevicePairingCard({ mutations }: { mutations: ClawMutations }) {
  const { data: pairing, isLoading, isFetching } = useKiloClawPairing(true);
  const refreshPairing = useRefreshPairing();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const spinning = isRefreshing || isFetching;

  const requests = pairing?.requests ?? [];
  const isApproving = mutations.approvePairingRequest.isPending;

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await refreshPairing();
    } catch {
      toast.error('Failed to refresh pairing requests');
    } finally {
      setIsRefreshing(false);
    }
  }

  function handleApprove(channel: string, code: string) {
    mutations.approvePairingRequest.mutate(
      { channel, code },
      {
        onSuccess: result => {
          if (result.success) {
            toast.success('Pairing approved');
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
      <Card>
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              Pairing Requests
            </CardTitle>
            <CardDescription>
              Approve pending pairing requests from sources like Telegram or Discord.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {requests.length > 0 ? (
          <div className="divide-y rounded-md border">
            {requests.map(request => (
              <div
                key={`${request.channel}:${request.code}`}
                className="flex items-center justify-between px-3 py-2"
              >
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
                  onClick={() => handleApprove(request.channel, request.code)}
                  disabled={isApproving}
                >
                  <Check className="h-3 w-3" />
                  Approve
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No pending pairing requests.</p>
        )}
      </CardContent>
    </Card>
  );
}
