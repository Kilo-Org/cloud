'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertTriangle, Info } from 'lucide-react';
import { toast } from 'sonner';
import { META_REGIONS, SPECIFIC_REGIONS, hasMixedRegionTypes } from './region-constants';

export function RegionsTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.kiloclawRegions.getRegions.queryOptions());

  const [inputValue, setInputValue] = useState('');
  const [dirty, setDirty] = useState(false);

  // Hydrate input from server data only when the form is pristine.
  useEffect(() => {
    if (data?.raw && !dirty) {
      setInputValue(data.raw);
    }
  }, [data?.raw, dirty]);

  const updateMutation = useMutation(
    trpc.admin.kiloclawRegions.updateRegions.mutationOptions({
      onSuccess: result => {
        toast.success('Regions updated');
        setInputValue(result.raw);
        setDirty(false);
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawRegions.getRegions.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to update regions: ${err.message}`);
      },
    })
  );

  const parsedInput = inputValue
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);

  const isMixed = hasMixedRegionTypes(parsedInput);
  const hasChanged = parsedInput.join(',') !== (data?.regions.join(',') ?? '');

  function handleSave() {
    updateMutation.mutate({ regions: parsedInput });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Current config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current Region Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : data ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">Source:</span>
                <Badge variant="outline">
                  {data.source === 'kv'
                    ? 'KV (runtime)'
                    : data.source === 'env'
                      ? 'Environment variable'
                      : 'Default'}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-sm">Regions:</span>
                {data.regions.map((r, i) => (
                  <Badge key={`${r}-${i}`} variant="secondary">
                    {r}
                  </Badge>
                ))}
              </div>
              <div className="text-muted-foreground text-xs">
                {data.regions.every(r => r === 'eu' || r === 'us')
                  ? 'Meta-regions only — order preserved (no shuffle).'
                  : 'Contains specific regions — order is shuffled for load distribution.'}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Failed to load region configuration.</p>
          )}
        </CardContent>
      </Card>

      {/* Edit regions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Update Regions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="region-input" className="text-sm font-medium">
              Region list (comma-separated)
            </label>
            <div className="flex gap-2">
              <Input
                id="region-input"
                value={inputValue}
                onChange={e => {
                  setInputValue(e.target.value);
                  setDirty(true);
                }}
                placeholder="e.g. eu,us or dfw,ord,lax"
                maxLength={200}
                className="font-mono"
              />
              <Button
                onClick={handleSave}
                disabled={updateMutation.isPending || parsedInput.length < 2 || !hasChanged}
              >
                {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
              </Button>
            </div>
            {parsedInput.length > 0 && parsedInput.length < 2 && (
              <p className="text-destructive text-xs">
                At least 2 regions required for fallback safety.
              </p>
            )}
          </div>

          {isMixed && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Mixing meta and specific regions causes all regions to be shuffled, including the
                meta ones. This is usually not intended.
              </AlertDescription>
            </Alert>
          )}

          <Alert variant="notice">
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>Meta-regions</strong> (eu, us) are Fly geographic aliases — Fly distributes
              across all datacenters in that area. Their order is preserved.
              <br />
              <strong>Specific regions</strong> (dfw, ord, etc.) are shuffled for load distribution.
              Duplicates bias the shuffle probability (e.g.{' '}
              <code className="text-xs">dfw,dfw,ord</code> gives DFW ~67% chance of being first).
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Reference table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Available Regions</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {META_REGIONS.map(r => (
                <TableRow key={r.code}>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell>{r.label}</TableCell>
                  <TableCell className="text-muted-foreground">{r.area}</TableCell>
                  <TableCell>
                    <Badge variant="outline">meta</Badge>
                  </TableCell>
                </TableRow>
              ))}
              {SPECIFIC_REGIONS.map(r => (
                <TableRow key={r.code}>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell>{r.label}</TableCell>
                  <TableCell className="text-muted-foreground">{r.area}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">specific</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
