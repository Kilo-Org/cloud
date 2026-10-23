'use client';

import { useId, useState } from 'react';
import {
  sessionShareDurationSchema,
  type SessionShareDuration,
  type SessionShareOptions,
} from '@kilocode/session-ingest-contracts';
import { Check, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useRawTRPCClient } from '@/lib/trpc/utils';

const durations = [
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'forever', label: 'Never expires' },
] satisfies { value: SessionShareDuration; label: string }[];

export function SessionSharePanel({
  kiloSessionId,
  isSharing,
  onSharingChange,
}: {
  kiloSessionId?: string;
  isSharing: boolean;
  onSharingChange: (isSharing: boolean) => void;
}) {
  const id = useId();
  const [duration, setDuration] = useState<SessionShareDuration>('7d');
  const [includeNewMessages, setIncludeNewMessages] = useState(false);
  const [share, setShare] = useState<({ url: string } & SessionShareOptions) | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const trpc = useRawTRPCClient();

  const handleShare = async () => {
    if (!kiloSessionId) {
      toast.error('Session ID is missing');
      return;
    }
    onSharingChange(true);
    const options = { duration, include_new_messages: includeNewMessages };
    try {
      const result = await trpc.cliSessionsV2.share.mutate({
        session_id: kiloSessionId,
        ...options,
      });
      setShare({
        url: new URL(`/s/${result.share_token}`, window.location.origin).toString(),
        ...options,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to share session');
    } finally {
      onSharingChange(false);
    }
  };

  const handleCopy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setIsCopied(true);
      toast.success('Link copied to clipboard');
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      toast.error('Failed to copy link');
    }
  };

  if (share) {
    const label = durations.find(option => option.value === share.duration)?.label;
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          {share.duration === 'forever'
            ? 'This link never expires.'
            : `This link expires in ${label}.`}{' '}
          {share.include_new_messages ? 'New messages are included.' : 'New messages are excluded.'}
        </p>
        <div className="ph-no-capture overflow-hidden rounded-md border bg-muted/50 p-3">
          <a
            href={share.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-sm break-all underline underline-offset-4"
          >
            {share.url}
          </a>
        </div>
        <Button variant="outline" onClick={handleCopy} className="w-full">
          {isCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {isCopied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${id}-duration`}>Link duration</Label>
        <Select
          value={duration}
          onValueChange={value => setDuration(sessionShareDurationSchema.parse(value))}
          disabled={isSharing}
        >
          <SelectTrigger id={`${id}-duration`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {durations.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-messages`}>Include new messages</Label>
          <p id={`${id}-messages-help`} className="text-muted-foreground text-xs">
            {includeNewMessages
              ? 'Anyone with this link can also read messages added later.'
              : 'Only content received before you create the link is included.'}
          </p>
        </div>
        <Switch
          id={`${id}-messages`}
          checked={includeNewMessages}
          onCheckedChange={setIncludeNewMessages}
          disabled={isSharing}
          aria-describedby={`${id}-messages-help`}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Anyone with this link can view the shared content. Creating a new link replaces any previous
        link. You can unshare at any time.
      </p>
      <Button onClick={handleShare} disabled={isSharing || !kiloSessionId} className="w-full">
        {isSharing && <Loader2 className="size-4 animate-spin" />}
        {isSharing ? 'Creating link...' : 'Create new link'}
      </Button>
    </div>
  );
}
