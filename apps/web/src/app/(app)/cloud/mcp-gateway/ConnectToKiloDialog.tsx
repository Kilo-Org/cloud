'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CopyButton } from './CopyButton';

type ConnectToKiloDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectUrl: string;
  suggestedName: string;
};

function Step({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium"
      >
        {number}
      </span>
      <div className="min-w-0 pt-0.5 text-sm">{children}</div>
    </li>
  );
}

export function ConnectToKiloDialog({
  open,
  onOpenChange,
  connectUrl,
  suggestedName,
}: ConnectToKiloDialogProps) {
  const jsonSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcp: {
            [suggestedName]: {
              type: 'remote',
              url: connectUrl,
              oauth: {},
            },
          },
        },
        null,
        2
      ),
    [connectUrl, suggestedName]
  );
  const askKiloPrompt = `Add a remote MCP server to my Kilo config named "${suggestedName}".
URL: ${connectUrl}
It requires OAuth authentication and uses dynamic client registration
(no pre-registered client ID). Add it to my global kilo.json.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add this gateway to Kilo</DialogTitle>
          <DialogDescription>
            Register this connection with Kilo Code. You'll be prompted to sign in the first time
            you use it.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="cli" className="min-w-0 space-y-4">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="cli">Kilo CLI</TabsTrigger>
            <TabsTrigger value="json">kilo.json</TabsTrigger>
            <TabsTrigger value="prompt">Ask Kilo</TabsTrigger>
          </TabsList>
          <TabsContent value="cli" className="min-w-0 space-y-4">
            <ol className="space-y-3">
              <Step number={1}>
                Run{' '}
                <code className="bg-muted/70 rounded px-1.5 py-0.5 font-mono text-xs">
                  kilo mcp add
                </code>
                <CopyButton
                  value="kilo mcp add"
                  ariaLabel="Copy kilo mcp add command"
                  toastLabel="Command copied"
                  size="sm"
                />
              </Step>
              <Step number={2}>
                Enter{' '}
                <code className="bg-muted/70 rounded px-1.5 py-0.5 font-mono text-xs">
                  {suggestedName}
                </code>
                <CopyButton
                  value={suggestedName}
                  ariaLabel="Copy suggested server name"
                  toastLabel="Server name copied"
                  size="sm"
                />
                <p className="text-muted-foreground mt-1 text-xs">Use a short name, not the URL.</p>
              </Step>
              <Step number={3}>
                Choose <Badge variant="secondary">Remote</Badge>.
              </Step>
              <Step number={4}>
                Paste the connect URL.
                <div className="bg-muted/70 mt-2 flex min-w-0 items-center gap-2 rounded-md px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs" title={connectUrl}>
                    {connectUrl}
                  </code>
                  <CopyButton
                    value={connectUrl}
                    ariaLabel="Copy connect URL"
                    toastLabel="Connect URL copied"
                  />
                </div>
              </Step>
              <Step number={5}>
                Does this server require OAuth authentication?{' '}
                <Badge variant="secondary">Yes</Badge>
              </Step>
              <Step number={6}>
                Do you have a pre-registered client ID? <Badge variant="secondary">No</Badge>
              </Step>
            </ol>
            <p className="text-muted-foreground text-xs">
              Kilo registers itself automatically the first time you connect.
            </p>
          </TabsContent>
          <TabsContent value="json" className="space-y-3">
            <p className="text-muted-foreground text-sm">
              Add this under mcp in your global ~/.config/kilo/kilo.json, or a project kilo.json.
            </p>
            <div className="bg-muted/70 relative rounded-md p-4">
              <CopyButton
                value={jsonSnippet}
                ariaLabel="Copy kilo.json snippet"
                toastLabel="kilo.json copied"
                className="absolute top-2 right-2"
              />
              <pre className="pr-10 text-xs leading-5">
                <code>{jsonSnippet}</code>
              </pre>
            </div>
          </TabsContent>
          <TabsContent value="prompt" className="space-y-3">
            <p className="text-muted-foreground text-sm">
              Paste this into Kilo Code and it'll add the server for you.
            </p>
            <div className="bg-muted/70 relative rounded-md p-4">
              <CopyButton
                value={askKiloPrompt}
                ariaLabel="Copy Kilo prompt"
                toastLabel="Prompt copied"
                className="absolute top-2 right-2"
              />
              <pre className="pr-10 text-xs leading-5 whitespace-pre-wrap">
                <code>{askKiloPrompt}</code>
              </pre>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
