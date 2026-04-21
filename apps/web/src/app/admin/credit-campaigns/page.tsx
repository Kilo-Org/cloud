'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Plus, X, Link as LinkIcon, ExternalLink } from 'lucide-react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { SortableButton } from '@/app/admin/components/SortableButton';
import { useTRPC } from '@/lib/trpc/utils';
import CampaignForm, { type CampaignFormValues } from './CampaignForm';

type SortField =
  | 'slug'
  | 'amount_microdollars'
  | 'credit_expiry_hours'
  | 'campaign_ends_at'
  | 'redemption_count'
  | 'total_dollars'
  | 'active'
  | 'last_redemption_at';

type SortConfig = { field: SortField; direction: 'asc' | 'desc' };

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Credit Campaigns</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function CreditCampaignsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listOptions = trpc.admin.creditCampaigns.list.queryOptions();
  const { data: campaigns, isLoading } = useQuery(listOptions);

  const [mode, setMode] = useState<
    { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; id: number }
  >({ kind: 'list' });

  const [sortConfig, setSortConfig] = useState<SortConfig>({
    field: 'last_redemption_at',
    direction: 'desc',
  });

  const handleSort = useCallback((field: SortField) => {
    setSortConfig(current =>
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'desc' }
    );
  }, []);

  const sortedCampaigns = useMemo(() => {
    if (!campaigns) return campaigns;
    const dirSign = sortConfig.direction === 'asc' ? 1 : -1;
    return [...campaigns].sort((a, b) => {
      const av = a[sortConfig.field];
      const bv = b[sortConfig.field];
      // Nulls always sort last regardless of direction — sorting a
      // nullable column otherwise makes the null cluster flip sides
      // on each click, which is disorienting.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * dirSign;
      }
      if (typeof av === 'boolean' && typeof bv === 'boolean') {
        return (Number(av) - Number(bv)) * dirSign;
      }
      return (Number(av) - Number(bv)) * dirSign;
    });
  }, [campaigns, sortConfig]);

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: listOptions.queryKey });

  const createMutation = useMutation(
    trpc.admin.creditCampaigns.create.mutationOptions({
      onSuccess: () => {
        toast.success('Campaign created');
        void invalidateList();
        setMode({ kind: 'list' });
      },
      onError: err => toast.error(err.message || 'Failed to create campaign'),
    })
  );
  const updateMutation = useMutation(
    trpc.admin.creditCampaigns.update.mutationOptions({
      onSuccess: () => {
        toast.success('Campaign updated');
        void invalidateList();
        setMode({ kind: 'list' });
      },
      onError: err => toast.error(err.message || 'Failed to update campaign'),
    })
  );
  // Track which campaign id is currently being toggled so we can disable
  // only that row's Switch. Binding `disabled` to `setActiveMutation.isPending`
  // would disable every row in the table whenever any toggle is in flight,
  // which is jarring on a list with many campaigns.
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const setActiveMutation = useMutation(
    trpc.admin.creditCampaigns.setActive.mutationOptions({
      onSuccess: () => {
        void invalidateList();
      },
      onError: err => toast.error(err.message || 'Failed to toggle campaign'),
      onSettled: () => setTogglingId(null),
    })
  );

  // Fetch the fresh campaign via `get` on edit rather than reading from the
  // list cache. If another admin edited the row since the list was last
  // fetched, the cached copy is stale and the form would silently overwrite
  // their changes on save. `get` hits the DB and returns the authoritative
  // current state. The `enabled` gate makes this a no-op outside edit mode.
  const editingId = mode.kind === 'edit' ? mode.id : null;
  const { data: editing, isLoading: editingLoading } = useQuery(
    trpc.admin.creditCampaigns.get.queryOptions(
      { id: editingId ?? 0 },
      { enabled: editingId !== null }
    )
  );

  const handleSubmit = (values: CampaignFormValues) => {
    if (mode.kind === 'create') {
      createMutation.mutate(values);
    } else if (mode.kind === 'edit') {
      // slug is intentionally dropped from the update payload — the router
      // schema doesn't accept it, and the form disables the input on edit.
      // Historical credit_transactions rows stay pinned to the original
      // credit_category; see updateCampaignInputSchema.
      const { slug: _slug, ...mutableFields } = values;
      updateMutation.mutate({ id: mode.id, ...mutableFields });
    }
  };

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Credit Campaigns</h2>
            <p className="text-muted-foreground mt-1">
              Admin managed signup bonus URLs. Each campaign powers a{' '}
              <code className="font-mono">/c/&lt;slug&gt;</code> URL that grants a credit to new
              users on signup.
            </p>
          </div>
          {mode.kind === 'list' && (
            <Button onClick={() => setMode({ kind: 'create' })}>
              <Plus className="mr-1 h-4 w-4" /> New Campaign
            </Button>
          )}
          {mode.kind !== 'list' && (
            <Button variant="outline" onClick={() => setMode({ kind: 'list' })}>
              <X className="mr-1 h-4 w-4" /> Cancel
            </Button>
          )}
        </div>

        {mode.kind === 'create' && (
          <Card>
            <CardHeader>
              <CardTitle>Create campaign</CardTitle>
              <CardDescription>
                Slug determines the public URL: <code>/c/&lt;slug&gt;</code>. Slugs are plaintext
                and intended to be shared publicly; abuse protection comes from the redemption cap +
                campaign end date + Stytch/Turnstile signup gate.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CampaignForm
                submitLabel="Create"
                pending={createMutation.isPending}
                onSubmit={handleSubmit}
              />
            </CardContent>
          </Card>
        )}

        {mode.kind === 'edit' && editingLoading && (
          <Card>
            <CardContent className="py-8">
              <p className="text-muted-foreground">Loading…</p>
            </CardContent>
          </Card>
        )}

        {mode.kind === 'edit' && editing && (
          <Card>
            <CardHeader>
              <CardTitle>Edit campaign</CardTitle>
              <CardDescription>
                Public URL: <code className="font-mono">/c/{editing.slug}</code>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CampaignForm
                submitLabel="Save"
                pending={updateMutation.isPending}
                slugReadOnly
                onSubmit={handleSubmit}
                defaultValues={{
                  slug: editing.slug,
                  amount_usd: Number(editing.amount_microdollars) / 1_000_000,
                  credit_expiry_hours: editing.credit_expiry_hours,
                  campaign_ends_at: editing.campaign_ends_at,
                  total_redemptions_allowed: editing.total_redemptions_allowed,
                  active: editing.active,
                  description: editing.description,
                }}
              />
            </CardContent>
          </Card>
        )}

        {mode.kind === 'list' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LinkIcon className="h-5 w-5" />
                Campaigns
              </CardTitle>
              <CardDescription>
                {campaigns?.length ?? 0} campaign{campaigns?.length === 1 ? '' : 's'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading && <p className="text-muted-foreground">Loading…</p>}
              {!isLoading && campaigns && campaigns.length === 0 && (
                <p className="text-muted-foreground">
                  No campaigns yet. Click <strong>New Campaign</strong> to create one.
                </p>
              )}
              {!isLoading && sortedCampaigns && sortedCampaigns.length > 0 && (
                <div className="overflow-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          <SortableButton field="slug" sortConfig={sortConfig} onSort={handleSort}>
                            Slug
                          </SortableButton>
                        </TableHead>
                        <TableHead>
                          <SortableButton
                            field="amount_microdollars"
                            sortConfig={sortConfig}
                            onSort={handleSort}
                          >
                            Amount
                          </SortableButton>
                        </TableHead>
                        <TableHead>
                          <SortableButton
                            field="credit_expiry_hours"
                            sortConfig={sortConfig}
                            onSort={handleSort}
                          >
                            Credit expiry
                          </SortableButton>
                        </TableHead>
                        <TableHead>
                          <SortableButton
                            field="campaign_ends_at"
                            sortConfig={sortConfig}
                            onSort={handleSort}
                          >
                            Campaign ends
                          </SortableButton>
                        </TableHead>
                        <TableHead>
                          <SortableButton
                            field="redemption_count"
                            sortConfig={sortConfig}
                            onSort={handleSort}
                          >
                            Redemptions
                          </SortableButton>
                        </TableHead>
                        <TableHead>
                          <SortableButton
                            field="total_dollars"
                            sortConfig={sortConfig}
                            onSort={handleSort}
                          >
                            Total spend
                          </SortableButton>
                        </TableHead>
                        <TableHead>
                          <SortableButton
                            field="active"
                            sortConfig={sortConfig}
                            onSort={handleSort}
                          >
                            Active
                          </SortableButton>
                        </TableHead>
                        <TableHead>
                          <SortableButton
                            field="last_redemption_at"
                            sortConfig={sortConfig}
                            onSort={handleSort}
                          >
                            Last redeemed
                          </SortableButton>
                        </TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedCampaigns.map(c => {
                        const cap = c.total_redemptions_allowed;
                        const amount = (Number(c.amount_microdollars) / 1_000_000).toFixed(2);
                        return (
                          <TableRow key={c.id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <code className="font-mono">{c.slug}</code>
                                <Link
                                  href={`/c/${c.slug}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-muted-foreground hover:text-foreground"
                                  title={`Open /c/${c.slug} in a new tab`}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </Link>
                              </div>
                            </TableCell>
                            <TableCell>${amount}</TableCell>
                            <TableCell>
                              {c.credit_expiry_hours ? `${c.credit_expiry_hours}h` : 'never'}
                            </TableCell>
                            <TableCell>{formatDateShort(c.campaign_ends_at)}</TableCell>
                            <TableCell>
                              {c.redemption_count}
                              {cap != null ? ` / ${cap}` : ''}
                            </TableCell>
                            <TableCell>
                              {c.total_dollars % 1 === 0
                                ? `$${c.total_dollars.toLocaleString()}`
                                : `$${c.total_dollars.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  })}`}
                            </TableCell>
                            <TableCell>
                              <Switch
                                checked={c.active}
                                disabled={togglingId === c.id}
                                onCheckedChange={checked => {
                                  setTogglingId(c.id);
                                  setActiveMutation.mutate({ id: c.id, active: checked });
                                }}
                              />
                            </TableCell>
                            <TableCell>{formatDateShort(c.last_redemption_at)}</TableCell>
                            <TableCell>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setMode({ kind: 'edit', id: c.id })}
                              >
                                Edit
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AdminPage>
  );
}
