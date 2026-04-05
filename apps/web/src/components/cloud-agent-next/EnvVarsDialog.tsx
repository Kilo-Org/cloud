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
import { AlertCircle, FileCode } from 'lucide-react';
import { toast } from 'sonner';
import { MonacoJsonEditor } from './MonacoJsonEditor';

type EnvVarsDialogProps = {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
};

const MAX_VARS = 50;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 256;

const EXAMPLE_JSON = `{
  "NODE_ENV": "production",
  "API_KEY": "your-api-key",
  "DATABASE_URL": "postgres://..."
}`;

export function EnvVarsDialog({ value, onChange }: EnvVarsDialogProps) {
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

      // Validate it's an object
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('Must be a valid JSON object');
        return;
      }

      // Validate count
      const keys = Object.keys(parsed);
      if (keys.length > MAX_VARS) {
        setError(`Maximum ${MAX_VARS} environment variables allowed`);
        return;
      }

      // Validate keys and values
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof key !== 'string' || key.length === 0) {
          setError('All keys must be non-empty strings');
          return;
        }
        if (key.length > MAX_KEY_LENGTH) {
          setError(`Key "${key}" exceeds ${MAX_KEY_LENGTH} characters`);
          return;
        }
        if (typeof val !== 'string') {
          setError(`Value for "${key}" must be a string`);
          return;
        }
        if (val.length > MAX_VALUE_LENGTH) {
          setError(`Value for "${key}" exceeds ${MAX_VALUE_LENGTH} characters`);
          return;
        }
      }

      // All validations passed
      onChange(parsed as Record<string, string>);
      setError(null);
      setOpen(false);
      toast.success('Environment variables saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON format');
    }
  };

  const handleClear = () => {
    onChange({});
    setJsonText('{}');
    setError(null);
    setOpen(false);
    toast.success('Environment variables cleared');
  };

  const varsCount = Object.keys(value).length;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileCode className="mr-2 h-4 w-4" />
          Environment Variables
          {varsCount > 0 && (
            <span className="bg-primary/10 ml-2 rounded-full px-2 py-0.5 text-xs">{varsCount}</span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Environment Variables</DialogTitle>
          <DialogDescription className="space-y-2">
            <span>
              Configure environment variables as JSON. Reference them in your prompt using{' '}
              <code className="bg-muted rounded px-1 py-0.5 text-xs">{'${env:VAR_NAME}'}</code>
            </span>
            <span className="text-muted-foreground block text-xs">
              Manual entries override values in the selected profile; secrets from profiles remain
              hidden.
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="envVars">
              JSON Configuration (max {MAX_VARS} variables, {MAX_KEY_LENGTH} chars per key/value)
            </Label>
            <MonacoJsonEditor
              value={jsonText}
              onChange={newValue => {
                setJsonText(newValue);
                setError(null);
              }}
              placeholder={EXAMPLE_JSON}
              height="200px"
            />
          </div>

          {error && (
            <div className="text-destructive flex items-start gap-2 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="text-muted-foreground space-y-1 text-xs">
            <p className="font-medium">Example:</p>
            <pre className="bg-muted overflow-x-auto rounded p-2">{EXAMPLE_JSON}</pre>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {varsCount > 0 && (
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
