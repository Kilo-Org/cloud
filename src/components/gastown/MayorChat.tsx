'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/Button';
import { toast } from 'sonner';
import { Send, Radio } from 'lucide-react';
import { AgentStream } from './AgentStream';

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

  // Poll mayor status every 3s when there's an active session
  const statusQuery = useQuery({
    ...trpc.gastown.getMayorStatus.queryOptions({ townId }),
    refetchInterval: query => {
      const session = query.state.data?.session;
      return session && (session.status === 'active' || session.status === 'starting')
        ? 3_000
        : false;
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
  const [showStream, setShowStream] = useState(true);

  // Latch the agentId: once we see an active/starting session, keep the
  // stream open even after the status transitions to idle. This prevents
  // the AgentStream from unmounting (and losing buffered events) when
  // the 3s status poll returns idle before all events have been streamed.
  const latchedAgentIdRef = useRef<string | null>(null);
  const currentAgentId = session?.agentId ?? null;
  const isSessionLive = session?.status === 'active' || session?.status === 'starting';

  // Latch when a session becomes active, and re-show the stream if
  // the agentId changes (new session started)
  if (isSessionLive && currentAgentId) {
    if (currentAgentId !== latchedAgentIdRef.current) {
      latchedAgentIdRef.current = currentAgentId;
      setShowStream(true);
    }
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

      {/* Mayor agent stream — shows live events when the mayor is working */}
      {mayorAgentId && showStream && (
        <AgentStream townId={townId} agentId={mayorAgentId} onClose={() => setShowStream(false)} />
      )}
    </div>
  );
}
