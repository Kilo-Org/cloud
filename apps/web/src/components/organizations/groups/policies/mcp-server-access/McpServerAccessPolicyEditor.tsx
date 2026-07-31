'use client';

import type { OrganizationGroupMcpServerAccessPolicy } from '@/lib/organizations/group-policies/organization-group-policies';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { OrganizationGroupPolicyEditorProps } from '@/components/organizations/groups/policies/types';
import { sortUniqueStrings } from '@/components/organizations/providers-and-models/allowLists.domain';
import { PolicyEditorFooter } from '@/components/organizations/groups/policies/PolicyEditorFooter';
import { Checkbox } from '@/components/ui/checkbox';
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

type Mode = OrganizationGroupMcpServerAccessPolicy['data']['mode'];

export function McpServerAccessPolicyEditor({
  organizationId,
  policy,
  isSaving,
  onSave,
  onCancel,
  onDelete,
  isDeleting,
}: OrganizationGroupPolicyEditorProps<'mcp_server_access'>) {
  const trpc = useTRPC();
  const editorDataQuery = useQuery(
    trpc.organizations.groups.getPolicyEditorData.queryOptions({
      organizationId,
      policyType: 'mcp_server_access',
    })
  );
  const editorData =
    editorDataQuery.data?.policyType === 'mcp_server_access' ? editorDataQuery.data : undefined;
  const servers = useMemo(() => editorData?.servers ?? [], [editorData]);
  const [mode, setMode] = useState<Mode>(policy.data.mode);
  const [configIds, setConfigIds] = useState<string[]>(
    policy.data.mode === 'selected' ? policy.data.config_ids : []
  );
  const [search, setSearch] = useState('');

  const selectedConfigIds = useMemo(() => new Set(configIds), [configIds]);
  const filteredServers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return servers;
    return servers.filter(
      server =>
        server.name.toLowerCase().includes(term) || server.remoteUrl.toLowerCase().includes(term)
    );
  }, [search, servers]);

  function save() {
    onSave(
      mode === 'selected'
        ? {
            type: 'mcp_server_access',
            data: { mode, config_ids: sortUniqueStrings([...selectedConfigIds]) },
          }
        : { type: 'mcp_server_access', data: { mode } }
    );
  }

  if (editorDataQuery.isLoading) {
    return <p className="type-body text-muted-foreground p-5">Loading MCP servers...</p>;
  }
  if (editorDataQuery.isError || !editorData) {
    return (
      <p role="alert" className="type-body text-status-destructive p-5">
        {editorDataQuery.error?.message ?? 'Unable to load organization MCP servers.'}
      </p>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="grid flex-1 content-start gap-4 p-5">
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-server-access-mode">Access mode</Label>
          <Select value={mode} onValueChange={value => setMode(value as Mode)}>
            {/* Raised above the drawer stack, which layers panels from z-60 up. */}
            <SelectTrigger id="mcp-server-access-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[70]">
              <SelectItem value="all">All organization MCP servers</SelectItem>
              <SelectItem value="none">No MCP server access</SelectItem>
              <SelectItem value="selected">Selected MCP servers</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === 'selected' &&
          (servers.length === 0 ? (
            <p className="type-body text-muted-foreground rounded-lg border px-4 py-6 text-center">
              This organization has no MCP servers yet. Add one in MCP Gateway, then grant it here.
            </p>
          ) : (
            <div className="grid gap-3">
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search MCP servers"
                aria-label="Search MCP servers"
              />
              <div className="rounded-lg border">
                <div className="flex items-center justify-between gap-4 border-b bg-muted/50 px-4 py-3">
                  <span className="type-label font-medium">MCP servers</span>
                  <span className="type-label text-muted-foreground">
                    {selectedConfigIds.size} selected • {filteredServers.length} shown
                  </span>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {filteredServers.length === 0 ? (
                    <p className="type-body text-muted-foreground px-4 py-6 text-center">
                      No MCP servers match your search.
                    </p>
                  ) : (
                    filteredServers.map(server => {
                      const checked = selectedConfigIds.has(server.configId);
                      return (
                        <label
                          key={server.configId}
                          className="flex cursor-pointer items-start gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/50"
                        >
                          <Checkbox
                            checked={checked}
                            className="mt-1"
                            onCheckedChange={nextChecked =>
                              setConfigIds(current =>
                                nextChecked
                                  ? sortUniqueStrings([...current, server.configId])
                                  : current.filter(value => value !== server.configId)
                              )
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="type-body block font-medium">{server.name}</span>
                            <span className="type-label text-muted-foreground block truncate">
                              {server.remoteUrl}
                            </span>
                            {(!server.enabled || server.sharingMode === 'single_user') && (
                              <span className="type-label text-muted-foreground block">
                                {!server.enabled
                                  ? 'Disabled in MCP Gateway'
                                  : 'Single-user server — only one member can connect'}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ))}

        <p className="type-label text-muted-foreground">
          MCP Gateway still resolves connections from per-member assignments, so this policy records
          intended access until gateway enforcement ships.
        </p>
      </div>
      <PolicyEditorFooter
        isSaving={isSaving}
        onSave={save}
        onCancel={onCancel}
        onDelete={onDelete}
        isDeleting={isDeleting}
      />
    </div>
  );
}
