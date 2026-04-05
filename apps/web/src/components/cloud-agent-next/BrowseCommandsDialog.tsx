'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { HelpCircle } from 'lucide-react';
import { useSlashCommandSets } from '@/hooks/useSlashCommandSets';

type BrowseCommandsDialogProps = {
  trigger?: React.ReactNode;
};

export function BrowseCommandsDialog({ trigger }: BrowseCommandsDialogProps) {
  const { allSets } = useSlashCommandSets();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <button
            type="button"
            className="text-muted-foreground inline-flex items-center gap-1 text-xs hover:text-gray-300"
            title="Browse available slash commands"
          >
            <HelpCircle className="h-3 w-3" />
            Commands
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Available Slash Commands</DialogTitle>
          <DialogDescription>
            Type / in the chat to see autocomplete. Use Tab or Shift+Enter to insert a command,
            Enter to insert and send immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {allSets.map(set => (
            <div key={set.id} className="border-b border-gray-700 pb-3 last:border-0">
              <div className="flex items-center gap-2">
                <Label className="text-base font-medium">{set.name}</Label>
                <span className="text-xs text-gray-500">({set.commands.length} commands)</span>
              </div>
              <p className="text-muted-foreground mt-1 text-sm">{set.description}</p>
              <div className="mt-3 space-y-2">
                {set.commands.map(cmd => (
                  <div
                    key={cmd.trigger}
                    className="rounded-md border border-gray-700 bg-gray-800/50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-blue-400">
                        /{cmd.trigger}
                      </span>
                      <span className="text-sm text-gray-300">{cmd.label}</span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">{cmd.description}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
