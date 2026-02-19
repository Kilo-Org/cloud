'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/Button';
import { toast } from 'sonner';
import { Send } from 'lucide-react';

type MayorChatProps = {
  townId: string;
  rigId?: string;
};

export function MayorChat({ townId }: MayorChatProps) {
  const [message, setMessage] = useState('');
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const sendMessage = useMutation(
    trpc.gastown.sendMessage.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.gastown.listAgents.queryKey() });
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

  return (
    <Card className="border-gray-700">
      <CardContent className="p-4">
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
  );
}
