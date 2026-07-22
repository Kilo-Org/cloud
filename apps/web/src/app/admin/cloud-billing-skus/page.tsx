'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Tags, X } from 'lucide-react';
import { toast } from 'sonner';
import AdminPage from '@/app/admin/components/AdminPage';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';
import type { CreateCloudBillingSkuInput } from '@/lib/cloud-billing-sku';
import CloudBillingSkuForm from './CloudBillingSkuForm';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Cloud Billing SKUs</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function CloudBillingSkusPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState<
    Partial<Record<keyof CreateCloudBillingSkuInput, string>>
  >({});
  const [disablingId, setDisablingId] = useState<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const listOptions = trpc.admin.cloudBillingSkus.list.queryOptions();
  const catalog = useQuery(listOptions);
  const { data: skus, isLoading } = catalog;
  const loadedSkus = skus ?? [];

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: listOptions.queryKey });
  const createMutation = useMutation(
    trpc.admin.cloudBillingSkus.create.mutationOptions({
      onSuccess: () => {
        toast.success('Billing SKU created');
        setCreating(false);
        setCreateErrors({});
        requestAnimationFrame(() => createButtonRef.current?.focus());
        void invalidateList();
      },
      onError: error => {
        const message = error.message || 'Could not create billing SKU';
        if (error.data?.code === 'CONFLICT') {
          setCreateErrors({ id: message });
          return;
        }
        toast.error(message);
      },
    })
  );
  const disableMutation = useMutation(
    trpc.admin.cloudBillingSkus.disable.mutationOptions({
      onSuccess: () => {
        toast.success('Billing SKU disabled for new usage');
        void invalidateList();
      },
      onError: error => toast.error(error.message || 'Could not disable billing SKU'),
      onSettled: () => setDisablingId(null),
    })
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="max-w-2xl">
            <h1 className="type-title">Cloud Billing SKUs</h1>
            <p className="text-muted-foreground mt-2 type-body">
              Immutable usage products reported by cloud services. A price change requires a new SKU
              and a producer deployment.
            </p>
          </div>
          {!creating ? (
            <Button
              ref={createButtonRef}
              onClick={() => {
                setCreateErrors({});
                setCreating(true);
              }}
            >
              <Plus className="size-4" /> Create SKU
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={createMutation.isPending}
              onClick={() => {
                setCreating(false);
                requestAnimationFrame(() => createButtonRef.current?.focus());
              }}
            >
              <X className="size-4" /> Cancel
            </Button>
          )}
        </div>

        {creating && (
          <Card>
            <CardHeader>
              <CardTitle>Create billing SKU</CardTitle>
              <CardDescription>
                Identity, unit, and rate cannot be edited after creation. Verify the previews before
                creating the SKU.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CloudBillingSkuForm
                pending={createMutation.isPending}
                serverErrors={createErrors}
                onSubmit={values => {
                  setCreateErrors({});
                  createMutation.mutate(values);
                }}
              />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Tags className="size-4" /> Catalog
            </CardTitle>
            <CardDescription>
              {catalog.isSuccess
                ? `${loadedSkus.length} SKU${loadedSkus.length === 1 ? '' : 's'} configured`
                : 'Named usage products and per-second rates'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading && <p className="text-muted-foreground type-body">Loading SKUs...</p>}
            {catalog.isError && (
              <Alert variant="destructive">
                <AlertTitle>Billing SKUs could not be loaded</AlertTitle>
                <AlertDescription>
                  <p>
                    {catalog.error.message || 'The billing SKU catalog is temporarily unavailable.'}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={catalog.isFetching}
                    onClick={() => void catalog.refetch()}
                  >
                    {catalog.isFetching ? 'Retrying...' : 'Retry'}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {catalog.isSuccess && loadedSkus.length === 0 && (
              <p className="text-muted-foreground type-body">
                No billing SKUs exist yet. An admin can create the first SKU.
              </p>
            )}
            {catalog.isSuccess && loadedSkus.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Rate</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loadedSkus.map(sku => (
                      <TableRow key={sku.id}>
                        <TableCell>
                          <div className="space-y-1">
                            <code className="type-code">{sku.id}</code>
                            <p className="font-medium type-body">{sku.name}</p>
                            {sku.description && (
                              <p className="text-muted-foreground max-w-lg type-label">
                                {sku.description}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="tabular-nums type-code">
                          {sku.rate_cents_per_unit} cents/{sku.unit}
                        </TableCell>
                        <TableCell>
                          <Badge variant={sku.accepts_new_usage ? 'new' : 'secondary'}>
                            {sku.accepts_new_usage ? 'Accepting usage' : 'Disabled'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground tabular-nums type-label">
                          {new Date(sku.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {sku.accepts_new_usage && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={disablingId === sku.id}
                                >
                                  Disable
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent
                                aria-busy={disablingId === sku.id}
                                onEscapeKeyDown={event => {
                                  if (disablingId === sku.id) event.preventDefault();
                                }}
                                onPointerDownOutside={event => {
                                  if (disablingId === sku.id) event.preventDefault();
                                }}
                              >
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Disable {sku.id}?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    New starts will be rejected. Existing usage can continue and the
                                    SKU cannot be re-enabled.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel disabled={disablingId === sku.id}>
                                    Cancel
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    variant="destructive"
                                    disabled={disablingId === sku.id}
                                    onClick={() => {
                                      setDisablingId(sku.id);
                                      disableMutation.mutate({ id: sku.id });
                                    }}
                                  >
                                    {disablingId === sku.id ? 'Disabling...' : 'Disable SKU'}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  );
}
