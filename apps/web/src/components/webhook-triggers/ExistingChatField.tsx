'use client';

import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc/utils';

type ExistingChatFieldProps = {
  organizationId?: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  readOnly: boolean;
};

export function ExistingChatField({
  organizationId,
  value,
  onChange,
  disabled,
  readOnly,
}: ExistingChatFieldProps) {
  const trpc = useTRPC();
  const {
    data: chats,
    isLoading,
    isError,
  } = useQuery(
    trpc.webhookTriggers.listChatTargets.queryOptions({ organizationId }, { enabled: !readOnly })
  );
  return (
    <div className="space-y-2">
      {!readOnly && (
        <>
          <Label htmlFor="recentTriggerChat">Recent workspace chats</Label>
          <Select
            value={chats?.some(chat => chat.id === value) ? value : ''}
            onValueChange={onChange}
            disabled={disabled || !chats?.length}
          >
            <SelectTrigger
              id="recentTriggerChat"
              className="w-full min-w-0 sm:max-w-lg"
              aria-describedby="triggerChatHelp"
            >
              <SelectValue
                placeholder={
                  isLoading
                    ? 'Loading chats…'
                    : isError
                      ? 'Could not load chats'
                      : chats?.length
                        ? 'Select a chat'
                        : 'No recent workspace chats'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {chats?.map(chat => (
                <SelectItem key={chat.id} value={chat.id}>
                  {chat.title || 'Untitled chat'} · {chat.workspaceName || chat.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      <Label htmlFor="triggerChatId">Cloud Agent chat ID</Label>
      <Input
        id="triggerChatId"
        value={value}
        onChange={event => onChange(event.target.value.trim())}
        readOnly={readOnly}
        disabled={disabled}
        placeholder="workspace_…"
        autoComplete="off"
        spellCheck={false}
        className="font-mono sm:max-w-lg"
        aria-describedby="triggerChatHelp"
      />
      <p id="triggerChatHelp" className="text-muted-foreground text-xs">
        {readOnly
          ? 'Create a new trigger to use a different chat.'
          : 'Select a chat or paste its workspace_ ID. Messages wait in the chat queue when it is busy.'}
      </p>
    </div>
  );
}
