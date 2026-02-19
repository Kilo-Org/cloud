'use client';

import { useState } from 'react';
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
        isActive ? 'bg-green-900/40 text-green-400' : 'bg-gray-800 text-gray-400'
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
        queryClient.invalidateQueries({
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

  // Show the agent stream when the mayor has an active session
  const mayorAgentId =
    session && (session.status === 'active' || session.status === 'starting')
      ? session.agentId
      : null;

  return (
    <div className="space-y-4">
      <Card className="border-gray-700">
        <CardContent className="p-4">
          {/* Status indicator */}
          {session && (
            <div className="mb-3 flex items-center justify-between text-sm">
              <SessionStatusBadge status={session.status} />
              <span className="text-xs text-gray-500">
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
              className="flex-1"
            />
            <Button
              variant="primary"
              size="md"
              type="submit"
              disabled={!message.trim() || sendMessage.isPending}
              className="gap-2"
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
