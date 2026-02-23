'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/Button';
import { toast } from 'sonner';
import { Send, Radio } from 'lucide-react';
import { AgentTerminal } from './AgentTerminal';

type MayorChatProps = {
  townId: string;
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Working',
  starting: 'Starting',
  idle: 'Idle',
};

function SessionStatusBadge({ status }: { status: string }) {
  const isActive = status === 'active' || status === 'starting';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        isActive
          ? 'bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-400/20'
          : 'bg-white/5 text-white/55 ring-1 ring-white/10'
      }`}
    >
      <Radio className={`size-2.5 ${isActive ? 'animate-pulse' : ''}`} />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function MayorChat({ townId }: MayorChatProps) {
  const [message, setMessage] = useState('');
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Eagerly ensure the mayor agent + container are running on mount.
  // This makes the terminal available immediately without requiring
  // the user to send a message first.
  const ensureMayor = useMutation(
    trpc.gastown.ensureMayor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getMayorStatus.queryKey(),
        });
      },
    })
  );

  const ensuredRef = useRef(false);
  useEffect(() => {
    if (ensuredRef.current) return;
    ensuredRef.current = true;
    ensureMayor.mutate({ townId });
  }, [townId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll mayor status — always poll at 5s so we pick up the agent once
  // the container finishes starting, then increase to 3s when active.
  const statusQuery = useQuery({
    ...trpc.gastown.getMayorStatus.queryOptions({ townId }),
    refetchInterval: query => {
      const session = query.state.data?.session;
      if (session?.status === 'active' || session?.status === 'starting') return 3_000;
      // Keep polling at a slower rate so we detect when the agent becomes available
      return 5_000;
    },
  });

  const sendMessage = useMutation(
    trpc.gastown.sendMessage.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getMayorStatus.queryKey(),
        });
        toast.success('Message sent to Mayor');
        setMessage('');
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    sendMessage.mutate({
      townId,
      message: message.trim(),
    });
  };

  const session = statusQuery.data?.session;
  const [showTerminal, setShowTerminal] = useState(true);

  // Latch agentId from any non-null session (not just active/starting).
  // Once the mayor agent exists (even if idle), the terminal can connect.
  const latchedAgentIdRef = useRef<string | null>(null);
  const currentAgentId = session?.agentId ?? null;

  if (currentAgentId && currentAgentId !== latchedAgentIdRef.current) {
    latchedAgentIdRef.current = currentAgentId;
    setShowTerminal(true);
  }

  const mayorAgentId = latchedAgentIdRef.current;

  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-transparent shadow-none">
        <CardContent className="p-4">
          {/* Status indicator */}
          {session && (
            <div className="mb-3 flex items-center justify-between text-sm">
              <SessionStatusBadge status={session.status} />
              <span className="text-xs text-white/45">
                Last activity: {new Date(session.lastActivityAt).toLocaleTimeString()}
              </span>
            </div>
          )}

          {/* Message input */}
          <form onSubmit={handleSubmit} className="flex gap-2">
            <Input
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Send a message to the Mayor..."
              disabled={sendMessage.isPending}
              className="flex-1 border-white/10 bg-black/25"
            />
            <Button
              variant="primary"
              size="md"
              type="submit"
              disabled={!message.trim() || sendMessage.isPending}
              className="gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Send className="size-4" />
              {sendMessage.isPending ? 'Sending...' : 'Send'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Mayor terminal — live PTY view of the mayor's kilo TUI session */}
      {mayorAgentId && showTerminal && (
        <AgentTerminal
          townId={townId}
          agentId={mayorAgentId}
          onClose={() => setShowTerminal(false)}
        />
      )}
    </div>
  );
}
