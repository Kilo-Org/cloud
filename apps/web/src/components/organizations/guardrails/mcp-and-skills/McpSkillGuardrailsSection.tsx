'use client';

import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Plus, Search } from 'lucide-react';
import type {
  OrganizationGuardrailEnforcement,
  OrganizationGuardrailType,
} from '@kilocode/db/schema-types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import { GUARDRAIL_TYPE_OPTIONS, configIdentity } from './guardrail-display';
import type { OrganizationGuardrailRow } from './guardrail-types';
import { AddMcpGuardrailDialog } from './AddMcpGuardrailDialog';
import { McpGuardrailsCard, SkillGuardrailsCard } from './McpSkillGuardrailsCards';
import { McpGuardrailsTable } from './McpGuardrailsTable';
import { EditMcpGuardrailDialog } from './EditMcpGuardrailDialog';
import { McpAuditLog } from './McpAuditLog';

const ALL_TYPES = 'all';

export function McpSkillGuardrailsSection({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const listQuery = useQuery(
    trpc.organizations.mcpGuardrails.list.queryOptions({ organizationId })
  );

  if (listQuery.isPending) {
    return (
      <div className="flex max-w-5xl flex-col gap-6" aria-busy="true">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (listQuery.isError) {
    return (
      <Alert variant="destructive" className="max-w-5xl">
        <AlertCircle />
        <AlertTitle>MCP servers and skills couldn’t load</AlertTitle>
        <AlertDescription className="grid gap-3">
          <span>{listQuery.error.message}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => void listQuery.refetch()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <McpSkillGuardrailsContent
      organizationId={organizationId}
      enforcement={listQuery.data.enforcement}
      guardrails={listQuery.data.guardrails}
    />
  );
}

function matchesSearch(guardrail: OrganizationGuardrailRow, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return [guardrail.name, guardrail.description ?? '', configIdentity(guardrail.config)].some(
    field => field.toLowerCase().includes(needle)
  );
}

function McpSkillGuardrailsContent({
  organizationId,
  enforcement,
  guardrails,
}: {
  organizationId: string;
  enforcement: {
    mcp: OrganizationGuardrailEnforcement;
    skill: { enabled: boolean; scanBeforeUse: boolean };
  };
  guardrails: OrganizationGuardrailRow[];
}) {
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <McpGuardrailsCard
        organizationId={organizationId}
        enforcement={enforcement.mcp}
        allowedCount={guardrails.length}
      >
        <AllowedMcpServers
          organizationId={organizationId}
          guardrails={guardrails}
          auditMode={enforcement.mcp === 'shadow'}
        />
        <McpAuditLog organizationId={organizationId} />
      </McpGuardrailsCard>

      <SkillGuardrailsCard organizationId={organizationId} guardrails={enforcement.skill} />
    </div>
  );
}

function AllowedMcpServers({
  organizationId,
  guardrails,
  auditMode,
}: {
  organizationId: string;
  guardrails: OrganizationGuardrailRow[];
  auditMode: boolean;
}) {
  const titleId = useId();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<OrganizationGuardrailType | typeof ALL_TYPES>(
    ALL_TYPES
  );
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const visibleGuardrails = useMemo(
    () =>
      guardrails.filter(
        guardrail =>
          (typeFilter === ALL_TYPES || guardrail.type === typeFilter) &&
          matchesSearch(guardrail, search)
      ),
    [guardrails, search, typeFilter]
  );

  const editing = guardrails.find(guardrail => guardrail.id === editingId) ?? null;
  const showToolbar = guardrails.length > 0;
  const showTypeFilter = GUARDRAIL_TYPE_OPTIONS.length > 1;

  return (
    <section aria-labelledby={titleId} className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h3 id={titleId} className="text-sm font-semibold">
            Allowed MCP servers
          </h3>
          <p className="text-muted-foreground text-sm">
            The MCP servers your members can use. Servers that aren’t listed are blocked, or only
            recorded while audit mode is on. Remove a server to stop allowing it.
          </p>
        </div>
        {showToolbar && (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add MCP server
          </Button>
        )}
      </div>

      {showToolbar && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-48 flex-1">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              placeholder="Search allowed MCP servers"
              aria-label="Search allowed MCP servers"
              className="pl-9"
              onChange={event => setSearch(event.target.value)}
            />
          </div>
          {showTypeFilter && (
            <Select
              value={typeFilter}
              onValueChange={value => setTypeFilter(value as OrganizationGuardrailType | 'all')}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Filter by type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_TYPES}>All types</SelectItem>
                {GUARDRAIL_TYPE_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}s
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {guardrails.length === 0 ? (
        <FirstRunState auditMode={auditMode} onAdd={() => setAdding(true)} />
      ) : visibleGuardrails.length === 0 ? (
        <EmptyState title="No matches" description="No allowed MCP servers match your search." />
      ) : (
        <McpGuardrailsTable
          organizationId={organizationId}
          guardrails={visibleGuardrails}
          onEdit={guardrail => setEditingId(guardrail.id)}
        />
      )}

      {editing && (
        <EditMcpGuardrailDialog
          key={editing.id}
          organizationId={organizationId}
          guardrail={editing}
          onClose={() => setEditingId(null)}
        />
      )}
      {adding && (
        <AddMcpGuardrailDialog organizationId={organizationId} onClose={() => setAdding(false)} />
      )}
    </section>
  );
}

function FirstRunState({ auditMode, onAdd }: { auditMode: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-5 rounded-md border border-dashed px-6 py-10 text-center">
      <div className="grid gap-1">
        <p className="text-sm font-medium">
          {auditMode
            ? 'Choose which MCP servers your members can use'
            : 'Members are blocked from using any MCP server'}
        </p>
        <p className="text-muted-foreground max-w-md text-sm">
          {auditMode
            ? 'Start with the MCP servers your team already relies on. Nothing is blocked while audit mode is on.'
            : 'No MCP servers are allowed, so every MCP server is blocked. Add the servers your team needs.'}
        </p>
      </div>
      <ol className="text-muted-foreground grid max-w-md list-decimal gap-1 pl-5 text-left text-sm">
        <li>Add the MCP servers your team uses.</li>
        <li>Keep audit mode on to see what else members connect, without blocking it.</li>
        <li>Turn audit mode off when you’re ready to block the rest.</li>
      </ol>
      <Button type="button" onClick={onAdd}>
        <Plus />
        Add MCP server
      </Button>
    </div>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-6 py-10 text-center">
      <div className="grid gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground max-w-md text-sm">{description}</p>
      </div>
      {action}
    </div>
  );
}
