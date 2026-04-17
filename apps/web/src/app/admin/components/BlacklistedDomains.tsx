'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Shield, Users } from 'lucide-react';

export function BlacklistedDomains() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.blacklistDomains.get.queryOptions());
  const { data: stats, isLoading: statsLoading } = useQuery(
    trpc.admin.blacklistDomains.stats.queryOptions()
  );

  const [inputValue, setInputValue] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setInputValue(data.domains.join('\n'));
      setHasChanges(false);
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.blacklistDomains.set.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.blacklistDomains.get.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.blacklistDomains.stats.queryKey(),
        });
        toast.success('Blacklisted domains updated');
      },
      onError: error => {
        toast.error(error.message || 'Failed to update');
      },
    })
  );

  function handleSave() {
    // Support both newline and pipe-separated input (e.g. pasting from the env var)
    const domains = inputValue
      .split(/[\n|]/)
      .map(part => part.trim().toLowerCase())
      .filter(Boolean);

    mutation.mutate({ domains });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const domainCount = data?.domains.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Editor card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Blacklisted Domains
              </CardTitle>
              <CardDescription>
                Email domains that are blocked from registration and access. Enter one domain per
                line (or paste a pipe-separated list). Subdomains are automatically blocked (e.g.
                blocking example.com also blocks sub.example.com).
              </CardDescription>
            </div>
            <div className="flex gap-4 text-sm">
              <Badge variant="secondary" className="px-3 py-1">
                {domainCount} {domainCount === 1 ? 'domain' : 'domains'}
              </Badge>
              {stats && (
                <Badge variant="destructive" className="px-3 py-1">
                  <Users className="mr-1 h-3 w-3" />
                  {stats.totalBlockedUsers.toLocaleString()} blocked users
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Textarea
            placeholder={'example.com\nspam.org\nmalicious.net'}
            value={inputValue}
            onChange={e => {
              setInputValue(e.target.value);
              setHasChanges(true);
            }}
            rows={15}
            className="font-mono text-sm"
          />

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
            {data?.updated_by_email && (
              <span className="text-muted-foreground text-sm">
                Last updated by {data.updated_by_email}
                {data.updated_at && <> at {new Date(data.updated_at).toLocaleString()}</>}
              </span>
            )}
          </div>

          <div className="text-muted-foreground text-xs">
            <p>
              Domains are stored in Redis for instant updates. Changes take effect immediately
              without a deploy. The BLACKLIST_DOMAINS env var is used as a fallback if Redis has no
              data.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Stats table */}
      <Card>
        <CardHeader>
          <CardTitle>Blocked Users by Domain</CardTitle>
          <CardDescription>
            Number of registered users matching each blacklisted domain
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="text-muted-foreground py-8 text-center text-sm">Loading stats...</div>
          ) : !stats || stats.domains.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center">
              No blacklisted domains configured
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead className="text-right">Blocked Users</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.domains.map(domain => (
                    <TableRow key={domain.domain}>
                      <TableCell className="font-medium">
                        <code className="bg-muted rounded px-2 py-1 text-sm">{domain.domain}</code>
                      </TableCell>
                      <TableCell className="text-right">
                        {domain.blockedCount > 0 ? (
                          <Badge variant={domain.blockedCount > 100 ? 'destructive' : 'secondary'}>
                            {domain.blockedCount.toLocaleString()}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
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
  );
}
