'use client';

import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CONFIG_IMPORT_SOURCES,
  detectConfigImportOs,
  getConfigImportCommands,
  type ConfigImportOs,
  type ConfigImportSource,
} from './config-import-commands';

export function ImportConfigCommands() {
  const [os, setOs] = useState<ConfigImportOs | null>(null);
  const [source, setSource] = useState<ConfigImportSource>('global');

  useEffect(() => {
    setOs(detectConfigImportOs(navigator.userAgent));
  }, []);

  const commands = os ? getConfigImportCommands(os) : [];

  return (
    <Tabs
      value={source}
      onValueChange={value => {
        if (value === 'global' || value === 'project') setSource(value);
      }}
      className="min-w-0 space-y-3 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Create the ZIP</p>
        <div className="flex flex-wrap items-center gap-2">
          <TabsList aria-label="Config to archive">
            {CONFIG_IMPORT_SOURCES.map(({ id, label }) => (
              <TabsTrigger key={id} value={id}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <Select
            value={os ?? ''}
            onValueChange={value => {
              if (value === 'windows' || value === 'macos' || value === 'linux') setOs(value);
            }}
          >
            <SelectTrigger aria-label="Operating system">
              <SelectValue placeholder="Choose operating system" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="macos">macOS</SelectItem>
              <SelectItem value="linux">Linux / WSL</SelectItem>
              <SelectItem value="windows">Windows (PowerShell)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {CONFIG_IMPORT_SOURCES.map(({ id, label, displayPath, archive }) => {
        const command = commands.find(entry => entry.id === id)?.command;
        return (
          <TabsContent key={id} value={id} className="mt-0 min-w-0 space-y-2">
            <p className="text-muted-foreground text-xs">
              {id === 'project' && 'Run from your project root. '}
              Zips{' '}
              <span className="text-foreground font-mono whitespace-nowrap">
                {displayPath}
              </span>{' '}
              into <span className="text-foreground font-mono whitespace-nowrap">~/{archive}</span>.
            </p>
            {command ? (
              <CommandField label={label} command={command} />
            ) : (
              <p className="text-muted-foreground text-xs">
                Choose your operating system to see the command.
              </p>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

function CommandField({ label, command }: { label: string; command: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Input
        readOnly
        value={command}
        spellCheck={false}
        aria-label={`${label} config zip command`}
        onFocus={event => event.currentTarget.select()}
        className="font-mono text-xs md:text-xs"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`Copy ${label.toLowerCase()} config zip command`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            toast.success('Command copied');
          } catch {
            toast.error('Could not copy the command. Select and copy it manually.');
          }
        }}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  );
}
