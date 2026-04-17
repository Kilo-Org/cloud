'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AlertTriangle, CheckCircle2, Shield, Users } from 'lucide-react';

function EditTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.blacklistDomains.get.queryOptions());

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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Blacklisted Domains
            </CardTitle>
            <CardDescription>
              Email domains that are blocked from registration and access. Enter one domain per line
              (or paste a pipe-separated list). Subdomains are automatically blocked (e.g. blocking
              example.com also blocks sub.example.com).
            </CardDescription>
          </div>
          <Badge variant="secondary" className="px-3 py-1">
            {domainCount} {domainCount === 1 ? 'domain' : 'domains'}
          </Badge>
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
            Domains are stored in Redis for instant updates. Changes take effect immediately without
            a deploy. The BLACKLIST_DOMAINS env var is used as a fallback if Redis has no data.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function StatsTab() {
  const trpc = useTRPC();

  const { data: stats, isLoading } = useQuery(trpc.admin.blacklistDomains.stats.queryOptions());

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Blocked Users by Domain</CardTitle>
            <CardDescription>
              Number of registered users matching each blacklisted domain
            </CardDescription>
          </div>
          {stats && (
            <div className="flex gap-4 text-sm">
              <Badge variant="secondary" className="px-3 py-1">
                {stats.totalDomains} {stats.totalDomains === 1 ? 'domain' : 'domains'}
              </Badge>
              <Badge variant="destructive" className="px-3 py-1">
                <Users className="mr-1 h-3 w-3" />
                {stats.totalBlockedUsers.toLocaleString()} blocked users
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
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
  );
}

function SuspiciousTab() {
  const trpc = useTRPC();

  const { data, isLoading } = useQuery(trpc.admin.blacklistDomains.suspicious.queryOptions());

  const domains = data?.domains ?? [];
  const blacklistedCount = domains.filter(d => d.isBlacklisted).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Suspicious Domains</CardTitle>
            <CardDescription>
              Top 100 registrable domains by blocked account count, then total account count. Only
              shows domains where at least 1% of accounts have been blocked, to filter out
              legitimate high-volume providers. Use this to spot domains that are accumulating abuse
              but aren&apos;t yet blacklisted.
            </CardDescription>
          </div>
          {data && (
            <div className="flex gap-4 text-sm">
              <Badge variant="secondary" className="px-3 py-1">
                {domains.length} {domains.length === 1 ? 'domain' : 'domains'}
              </Badge>
              <Badge variant="outline" className="px-3 py-1">
                <Shield className="mr-1 h-3 w-3" />
                {blacklistedCount} already blacklisted
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-muted-foreground py-8 text-center text-sm">Loading…</div>
        ) : domains.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">No data</div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                  <TableHead className="text-right">Blocked</TableHead>
                  <TableHead className="text-right">% Blocked</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map(domain => (
                  <TableRow
                    key={domain.domain}
                    className={domain.isBlacklisted ? 'bg-muted/60' : undefined}
                  >
                    <TableCell>
                      {domain.isBlacklisted ? (
                        <Badge variant="secondary" className="gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          Blacklisted
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Not blacklisted
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell
                      className={domain.isBlacklisted ? 'text-muted-foreground' : 'font-medium'}
                    >
                      <code className="bg-muted rounded px-2 py-1 text-sm">{domain.domain}</code>
                    </TableCell>
                    <TableCell className="text-right">
                      {domain.accountCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {domain.blockedAccountCount > 0 ? (
                        <Badge
                          variant={domain.blockedAccountCount > 100 ? 'destructive' : 'secondary'}
                        >
                          {domain.blockedAccountCount.toLocaleString()}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {domain.blockedAccountPercent.toFixed(2)}%
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatTimestamp(domain.firstSeen)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatTimestamp(domain.lastSeen)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString();
}

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export function BlacklistedDomains() {
  const [activeTab, setActiveTab] = useState('edit');

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
        <TabsTrigger value="edit" className={tabTriggerClass}>
          Edit
        </TabsTrigger>
        <TabsTrigger value="stats" className={tabTriggerClass}>
          Stats
        </TabsTrigger>
        <TabsTrigger value="suspicious" className={tabTriggerClass}>
          Suspicious
        </TabsTrigger>
      </TabsList>
      <TabsContent value="edit" className="mt-4">
        <EditTab />
      </TabsContent>
      <TabsContent value="stats" className="mt-4">
        {activeTab === 'stats' && <StatsTab />}
      </TabsContent>
      <TabsContent value="suspicious" className="mt-4">
        {activeTab === 'suspicious' && <SuspiciousTab />}
      </TabsContent>
    </Tabs>
  );
}
