'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Shield, Users } from 'lucide-react';

type DomainData = {
  domain: string;
  blockedCount: number;
};

type BlacklistedDomainsData = {
  domains: DomainData[];
  totalDomains: number;
  totalBlockedUsers: number;
};

export function BlacklistedDomains() {
  const [data, setData] = useState<BlacklistedDomainsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetch('/admin/api/abuse/blacklisted-domains');
        if (!response.ok) {
          throw new Error('Failed to fetch blacklisted domains');
        }
        const result = await response.json();
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    }

    void fetchData();
  }, []);

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-muted-foreground text-center">Loading blacklisted domains...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-destructive text-center">Error: {error}</div>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Blacklisted Domains
            </CardTitle>
            <CardDescription>Email domains that are blocked from registration</CardDescription>
          </div>
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="px-3 py-1">
                {data.totalDomains} domains
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="destructive" className="px-3 py-1">
                <Users className="mr-1 h-3 w-3" />
                {data.totalBlockedUsers.toLocaleString()} blocked users
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {data.domains.length === 0 ? (
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
                {data.domains.map(domain => (
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
        <div className="text-muted-foreground mt-4 text-xs">
          <p>
            Domains are matched against email addresses using both @domain and .domain patterns.
            This list is configured via the BLACKLIST_DOMAINS environment variable.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
