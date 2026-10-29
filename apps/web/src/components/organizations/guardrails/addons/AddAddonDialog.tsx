'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTRPC } from '@/lib/trpc/utils';
import { CustomMcpForm } from './CustomMcpForm';
import {
  McpRegistryPicker,
  selectionKey,
  type McpRegistrySource,
  type McpSelectionState,
} from './McpRegistryPicker';

type AddTab = McpRegistrySource | 'custom';

export function AddAddonDialog({
  organizationId,
  onClose,
}: {
  organizationId: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AddTab>('kilo_marketplace');
  const [selection, setSelection] = useState<McpSelectionState>({});
  const [isAdding, setIsAdding] = useState(false);
  const selectedEntries = Object.values(selection);

  const addMutation = useMutation(trpc.organizations.addons.add.mutationOptions());

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.organizations.addons.list.queryKey({ organizationId }),
      }),
      queryClient.invalidateQueries({ queryKey: trpc.organizations.addons.browse.pathKey() }),
    ]);
  };

  const addSelected = async () => {
    setIsAdding(true);
    const failures: string[] = [];
    const remaining: McpSelectionState = {};
    let added = 0;
    for (const entry of selectedEntries) {
      try {
        await addMutation.mutateAsync({
          organizationId,
          type: 'mcp',
          source: entry.source,
          sourceId: entry.sourceId,
          identityKey: entry.identityKey,
          ...(entry.isPackage ? { minVersion: entry.minVersion } : {}),
        });
        added += 1;
      } catch (error) {
        remaining[entry.key] = entry;
        failures.push(
          `${entry.name}: ${error instanceof Error ? error.message : 'It couldn’t be added.'}`
        );
      }
    }
    await refresh();
    setIsAdding(false);
    setSelection(remaining);
    if (added > 0) {
      toast.success(
        added === 1 ? 'Added 1 allowed MCP server.' : `Added ${added} allowed MCP servers.`
      );
    }
    if (failures.length > 0) {
      toast.error(failures.join('\n'));
    } else {
      onClose();
    }
  };

  const isRegistryTab = tab !== 'custom';

  return (
    <Dialog open onOpenChange={open => !open && !isAdding && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add server</DialogTitle>
          <DialogDescription>
            Allow users to access a known MCP server, or define a custom MCP server
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={value => setTab(value as AddTab)}>
          <TabsList>
            <TabsTrigger value="kilo_marketplace">Kilo registry</TabsTrigger>
            <TabsTrigger value="mcp_registry">MCP registry</TabsTrigger>
            <TabsTrigger value="custom">Custom</TabsTrigger>
          </TabsList>

          {(['kilo_marketplace', 'mcp_registry'] as const).map(source => (
            <TabsContent key={source} value={source} className="mt-4">
              <McpRegistryPicker
                organizationId={organizationId}
                source={source}
                selection={selection}
                onToggle={(item, variant, checked) => {
                  const key = selectionKey(item.source, item.sourceId, variant.identityKey);
                  setSelection(current => {
                    if (!checked) {
                      const { [key]: _removed, ...rest } = current;
                      return rest;
                    }
                    return {
                      ...current,
                      [key]: {
                        key,
                        source: item.source,
                        sourceId: item.sourceId,
                        identityKey: variant.identityKey,
                        name: item.name,
                        isPackage: variant.target.kind === 'package',
                        minVersion: variant.versionHint ?? '',
                      },
                    };
                  });
                }}
                onMinVersionChange={(key, minVersion) =>
                  setSelection(current =>
                    current[key] ? { ...current, [key]: { ...current[key], minVersion } } : current
                  )
                }
              />
            </TabsContent>
          ))}

          <TabsContent value="custom" className="mt-4">
            <CustomMcpForm
              organizationId={organizationId}
              onCancel={onClose}
              onSaved={async () => {
                await refresh();
                toast.success('Added 1 allowed MCP server.');
                onClose();
              }}
            />
          </TabsContent>
        </Tabs>

        {isRegistryTab && (
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isAdding} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={selectedEntries.length === 0 || isAdding}
              onClick={() => void addSelected()}
            >
              {isAdding
                ? 'Adding…'
                : selectedEntries.length > 1
                  ? `Add ${selectedEntries.length} MCP servers`
                  : 'Add MCP server'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
