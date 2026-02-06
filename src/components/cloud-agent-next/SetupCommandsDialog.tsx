'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { AlertCircle, Terminal } from 'lucide-react';
import { toast } from 'sonner';

type SetupCommandsDialogProps = {
  value: string[];
  onChange: (value: string[]) => void;
};

const MAX_COMMANDS = 20;
const MAX_COMMAND_LENGTH = 500;

const EXAMPLE_JSON = `[
  "npm install",
  "pip install -r requirements.txt",
  "cp .env.example .env",
  "npm run build"
]`;

export function SetupCommandsDialog({ value, onChange }: SetupCommandsDialogProps) {
  const [open, setOpen] = useState(false);
  const [jsonText, setJsonText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  const handleOpen = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      // Reset to current value when opening
      setJsonText(JSON.stringify(value, null, 2));
      setError(null);
    }
  };

  const validateAndSave = () => {
    try {
      const parsed = JSON.parse(jsonText);

      // Validate it's an array
      if (!Array.isArray(parsed)) {
        setError('Must be a valid JSON array');
        return;
      }

      // Validate count
      if (parsed.length > MAX_COMMANDS) {
        setError(`Maximum ${MAX_COMMANDS} commands allowed`);
        return;
      }

      // Validate each command
      for (let i = 0; i < parsed.length; i++) {
        const cmd = parsed[i];
        if (typeof cmd !== 'string') {
          setError(`Command at index ${i} must be a string`);
          return;
        }
        if (cmd.trim().length === 0) {
          setError(`Command at index ${i} cannot be empty`);
          return;
        }
        if (cmd.length > MAX_COMMAND_LENGTH) {
          setError(`Command at index ${i} exceeds ${MAX_COMMAND_LENGTH} characters`);
          return;
        }
      }

      // All validations passed
      onChange(parsed as string[]);
      setError(null);
      setOpen(false);
      toast.success('Setup commands saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON format');
    }
  };

  const handleClear = () => {
    onChange([]);
    setJsonText('[]');
    setError(null);
    setOpen(false);
    toast.success('Setup commands cleared');
  };

  const commandsCount = value.length;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Terminal className="mr-2 h-4 w-4" />
          Setup Commands
          {commandsCount > 0 && (
            <span className="bg-primary/10 ml-2 rounded-full px-2 py-0.5 text-xs">
              {commandsCount}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Setup Commands</DialogTitle>
          <DialogDescription>
            Configure bash commands to run before starting the agent. Commands are executed in
            order.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="setupCommands">
              JSON Array (max {MAX_COMMANDS} commands, {MAX_COMMAND_LENGTH} chars each)
            </Label>
            <Textarea
              id="setupCommands"
              value={jsonText}
              onChange={e => {
                setJsonText(e.target.value);
                setError(null);
              }}
              placeholder={EXAMPLE_JSON}
              className="min-h-[200px] font-mono text-sm"
            />
          </div>

          {error && (
            <div className="text-destructive flex items-start gap-2 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="text-muted-foreground space-y-1 text-xs">
            <p className="font-medium">Common examples:</p>
            <pre className="bg-muted overflow-x-auto rounded p-2">{EXAMPLE_JSON}</pre>
            <p className="mt-2 text-xs">
              <strong>Note:</strong> Commands run in the repository root with bash shell.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {commandsCount > 0 && (
            <Button variant="ghost" onClick={handleClear} className="text-destructive">
              Clear All
            </Button>
          )}
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={validateAndSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
