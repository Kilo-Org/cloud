'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function VercelModelIdOverridesContent() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(trpc.admin.vercelModelIdOverrides.list.queryOptions());

  const items = data?.items ?? [];

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading overrides...</div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model ID Overrides</CardTitle>
        <CardDescription>
          Read-only. The provider and model sync generates these from models.dev canonical IDs and
          legacy aliases, keeping only OpenRouter model IDs whose Vercel ID differs from the
          built-in mapping.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>OpenRouter model ID</TableHead>
              <TableHead>Vercel model ID</TableHead>
              <TableHead>Built-in mapping</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground text-center text-sm">
                  No overrides. The built-in mapping applies to every model.
                </TableCell>
              </TableRow>
            )}
            {items.map(item => (
              <TableRow key={item.openrouter_model_id}>
                <TableCell className="font-mono text-sm">{item.openrouter_model_id}</TableCell>
                <TableCell className="font-mono text-sm">{item.vercel_model_id}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-sm">
                  {item.builtin_vercel_model_id}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
