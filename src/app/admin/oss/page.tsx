'use client';

import { useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Search,
  Plus,
  Download,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
} from 'lucide-react';

type CsvRow = {
  githubUrl: string;
  email: string;
  creditsDollars: number;
  tier: 1 | 2 | 3;
};

type SkippedRow = {
  lineNumber: number;
  rawLine: string;
  reason: string;
};

type ImportResult = {
  email: string;
  orgId: string | null;
  success: boolean;
  error?: string;
};

/**
 * Extract repository name from a GitHub URL.
 * Examples:
 * - https://github.com/owner/repo -> repo
 * - https://github.com/owner/repo.git -> repo
 * - github.com/owner/repo -> repo
 */
function extractRepoName(githubUrl: string): string | null {
  try {
    // Handle URLs without protocol
    let url = githubUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    const parsed = new URL(url);
    if (!parsed.hostname.includes('github.com')) {
      return null;
    }
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) {
      return null;
    }
    // Get repo name (second part of path), remove .git extension if present
    const repoName = pathParts[1].replace(/\.git$/, '');
    return repoName || null;
  } catch {
    return null;
  }
}

function parseCsv(text: string): { rows: CsvRow[]; skippedRows: SkippedRow[] } {
  const lines = text.trim().split('\n');
  const rows: CsvRow[] = [];
  const skippedRows: SkippedRow[] = [];
  const seenRepos = new Set<string>(); // Track repos seen in this upload to detect duplicates

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Skip header row if it looks like one
    if (
      i === 0 &&
      (line.toLowerCase().includes('github') || line.toLowerCase().includes('email'))
    ) {
      continue;
    }

    const parts = line.split(',').map(p => p.trim());

    // Require exactly 4 columns
    if (parts.length !== 4) {
      skippedRows.push({
        lineNumber: i + 1,
        rawLine: line,
        reason: `Expected 4 columns (github, email, credits, tier), got ${parts.length}`,
      });
      continue;
    }

    const [githubUrl, email, creditsStr, tierStr] = parts;

    // Validate GitHub URL
    if (!githubUrl) {
      skippedRows.push({
        lineNumber: i + 1,
        rawLine: line,
        reason: 'Missing GitHub URL',
      });
      continue;
    }

    const repoName = extractRepoName(githubUrl);
    if (!repoName) {
      skippedRows.push({
        lineNumber: i + 1,
        rawLine: line,
        reason: `Invalid GitHub URL "${githubUrl}"`,
      });
      continue;
    }

    // Check for duplicate repos within the same CSV upload
    const repoNameLower = repoName.toLowerCase();
    if (seenRepos.has(repoNameLower)) {
      skippedRows.push({
        lineNumber: i + 1,
        rawLine: line,
        reason: `Duplicate repository "${repoName}" in this upload`,
      });
      continue;
    }
    seenRepos.add(repoNameLower);

    // Validate email
    if (!email || !email.includes('@')) {
      skippedRows.push({
        lineNumber: i + 1,
        rawLine: line,
        reason: `Invalid email "${email}"`,
      });
      continue;
    }

    // Validate credits
    const creditsDollars = parseFloat(creditsStr);
    if (isNaN(creditsDollars) || creditsDollars < 0) {
      skippedRows.push({
        lineNumber: i + 1,
        rawLine: line,
        reason: `Invalid credits value "${creditsStr}"`,
      });
      continue;
    }

    // Validate tier
    const tier = parseInt(tierStr, 10);
    if (![1, 2, 3].includes(tier)) {
      skippedRows.push({
        lineNumber: i + 1,
        rawLine: line,
        reason: `Tier must be 1, 2, or 3, got "${tierStr}"`,
      });
      continue;
    }

    rows.push({ githubUrl, email, creditsDollars, tier: tier as 1 | 2 | 3 });
  }

  return { rows, skippedRows };
}

function generateSkippedRowsCsv(skippedRows: SkippedRow[]): string {
  const header = 'Line Number,Raw Line,Reason';
  const rows = skippedRows.map(
    row =>
      `${row.lineNumber},"${row.rawLine.replace(/"/g, '""')}","${row.reason.replace(/"/g, '""')}"`
  );
  return [header, ...rows].join('\n');
}

function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function CsvUploadSection() {
  const trpc = useTRPC();
  const [isDragging, setIsDragging] = useState(false);
  const [parsedRows, setParsedRows] = useState<CsvRow[]>([]);
  const [skippedRows, setSkippedRows] = useState<SkippedRow[]>([]);
  const [importResults, setImportResults] = useState<ImportResult[] | null>(null);

  const processOssCsvMutation = useMutation(
    trpc.admin.ossSponsorship.processOssCsv.mutationOptions({
      onSuccess: results => {
        setImportResults(results);
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        if (failCount === 0) {
          toast.success(`Successfully imported ${successCount} sponsorships`);
        } else {
          toast.warning(`Imported ${successCount} sponsorships, ${failCount} failed`);
        }
      },
      onError: error => {
        toast.error(error.message || 'Failed to process CSV');
      },
    })
  );

  const handleFile = useCallback((file: File) => {
    setImportResults(null);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      const { rows, skippedRows: skipped } = parseCsv(text);
      setParsedRows(rows);
      setSkippedRows(skipped);
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleImport = () => {
    if (parsedRows.length === 0) return;
    processOssCsvMutation.mutate(parsedRows);
  };

  const handleClear = () => {
    setParsedRows([]);
    setSkippedRows([]);
    setImportResults(null);
  };

  const handleDownloadSkipped = () => {
    if (skippedRows.length === 0) return;
    const csvContent = generateSkippedRowsCsv(skippedRows);
    downloadCsv(csvContent, 'skipped-rows.csv');
  };

  // Extract repo name for display
  const getRepoName = (githubUrl: string) => extractRepoName(githubUrl) || 'Unknown';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          CSV Import
        </CardTitle>
        <CardDescription>
          Upload a CSV file with 4 columns: GitHub URL, email, credits (USD), tier (1, 2, or 3). The
          organization name will be extracted from the GitHub repository name.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={`relative flex min-h-[150px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-muted-foreground/50'
          }`}
        >
          <FileSpreadsheet className="text-muted-foreground mb-2 h-10 w-10" />
          <p className="text-muted-foreground text-sm">Drop CSV file here or click to browse</p>
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={handleInputChange}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>

        {/* Skipped rows */}
        {skippedRows.length > 0 && (
          <div className="border-destructive/50 bg-destructive/10 rounded-lg border p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-destructive flex items-center gap-2 font-medium">
                <AlertCircle className="h-4 w-4" />
                Skipped rows ({skippedRows.length})
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadSkipped}
                className="text-destructive border-destructive/50 hover:bg-destructive/10"
              >
                <Download className="mr-1 h-4 w-4" />
                Download Skipped
              </Button>
            </div>
            <ul className="text-muted-foreground list-disc pl-5 text-sm">
              {skippedRows.slice(0, 5).map((row, i) => (
                <li key={i}>
                  Line {row.lineNumber}: {row.reason}
                </li>
              ))}
              {skippedRows.length > 5 && <li>...and {skippedRows.length - 5} more</li>}
            </ul>
          </div>
        )}

        {/* Preview table */}
        {parsedRows.length > 0 && !importResults && (
          <div className="space-y-4">
            <p className="text-sm font-medium">Preview ({parsedRows.length} rows)</p>
            <div className="max-h-[300px] overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Org Name (from GitHub)</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Credits ($)</TableHead>
                    <TableHead>Tier</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <div className="space-y-1">
                          <p className="font-medium">{getRepoName(row.githubUrl)}</p>
                          <p
                            className="text-muted-foreground truncate text-xs"
                            title={row.githubUrl}
                          >
                            {row.githubUrl}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{row.email}</TableCell>
                      <TableCell>${row.creditsDollars.toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">Tier {row.tier}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleImport} disabled={processOssCsvMutation.isPending}>
                {processOssCsvMutation.isPending
                  ? 'Importing...'
                  : `Import ${parsedRows.length} Sponsorships`}
              </Button>
              <Button
                variant="outline"
                onClick={handleClear}
                disabled={processOssCsvMutation.isPending}
              >
                Clear
              </Button>
            </div>
          </div>
        )}

        {/* Import results */}
        {importResults && (
          <div className="space-y-4">
            <p className="text-sm font-medium">Import Results</p>
            <div className="max-h-[300px] overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Organization ID</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importResults.map((result, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        {result.success ? (
                          <CheckCircle2 className="h-5 w-5 text-green-500" />
                        ) : (
                          <XCircle className="text-destructive h-5 w-5" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{result.email}</TableCell>
                      <TableCell>
                        {result.orgId ? (
                          <Link
                            href={`/admin/organizations/${result.orgId}`}
                            className="font-mono text-sm text-blue-400 hover:underline"
                          >
                            {result.orgId.slice(0, 8)}...
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-destructive text-sm">
                        {result.error || ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Button variant="outline" onClick={handleClear}>
              Clear & Upload New
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type SearchResult = {
  id: string;
  name: string;
  plan: string;
  requireSeats: boolean;
  suppressTrialMessaging: boolean;
};

type SelectedOrg = SearchResult | null;

function AddExistingOrgSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrg, setSelectedOrg] = useState<SelectedOrg>(null);
  const [tier, setTier] = useState<1 | 2 | 3>(1);
  const [monthlyTopUpDollars, setMonthlyTopUpDollars] = useState<number>(100);
  const [addInitialGrant, setAddInitialGrant] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const searchQueryOptions = trpc.admin.ossSponsorship.searchOrganizations.queryOptions(
    { query: searchQuery },
    { enabled: searchQuery.length >= 2 }
  );
  const { data: searchResults = [], isLoading: isSearching } = useQuery(searchQueryOptions);

  const addToOssMutation = useMutation(
    trpc.admin.ossSponsorship.addExistingOrgToOss.mutationOptions({
      onSuccess: result => {
        const initialGrantMsg = result.addInitialGrant
          ? `, $${result.monthlyTopUpDollars} initial credits`
          : '';
        toast.success(
          `Added ${selectedOrg?.name ?? 'organization'} to OSS program (Tier ${result.tier}${initialGrantMsg}, $${result.monthlyTopUpDollars}/mo top-up)`
        );
        setDialogOpen(false);
        setSelectedOrg(null);
        setSearchQuery('');
        // Invalidate the sponsorships list
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.ossSponsorship.listOssSponsorships.queryKey(),
        });
      },
      onError: error => {
        toast.error(error.message || 'Failed to add organization to OSS program');
      },
    })
  );

  const handleSelectOrg = (org: SearchResult) => {
    setSelectedOrg(org);
    setDialogOpen(true);
  };

  const handleConfirmAdd = () => {
    if (!selectedOrg) return;
    addToOssMutation.mutate({
      organizationId: selectedOrg.id,
      tier,
      monthlyTopUpDollars,
      addInitialGrant,
    });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            Add Existing Organization to OSS Program
          </CardTitle>
          <CardDescription>
            Search for an existing organization to add to the OSS sponsorship program
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Input
              type="text"
              placeholder="Search by organization name or ID..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="max-w-md"
            />
            {searchQuery.length > 0 && searchQuery.length < 2 && (
              <p className="text-muted-foreground text-sm">Type at least 2 characters to search</p>
            )}
          </div>

          {isSearching && <div className="text-muted-foreground py-4 text-sm">Searching...</div>}

          {!isSearching && searchQuery.length >= 2 && searchResults.length === 0 && (
            <div className="text-muted-foreground py-4 text-sm">
              No organizations found matching &quot;{searchQuery}&quot;
            </div>
          )}

          {searchResults.length > 0 && (
            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization Name</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Require Seats</TableHead>
                    <TableHead>Suppress Trial</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {searchResults.map(org => (
                    <TableRow key={org.id}>
                      <TableCell>
                        <div className="space-y-1">
                          <p className="font-medium">{org.name}</p>
                          <p className="text-muted-foreground font-mono text-xs">
                            {org.id.slice(0, 8)}...
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={org.plan === 'enterprise' ? 'default' : 'secondary'}>
                          {org.plan}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={org.requireSeats ? 'secondary' : 'outline'}>
                          {org.requireSeats ? 'Yes' : 'No'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={org.suppressTrialMessaging ? 'outline' : 'secondary'}>
                          {org.suppressTrialMessaging ? 'Yes' : 'No'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => handleSelectOrg(org)}>
                          <Plus className="mr-1 h-4 w-4" />
                          Add to OSS
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to OSS Program</DialogTitle>
            <DialogDescription>
              Configure the OSS sponsorship settings for{' '}
              <span className="font-semibold">{selectedOrg?.name}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="tier">Sponsorship Tier</Label>
              <select
                id="tier"
                value={tier}
                onChange={e => setTier(Number(e.target.value) as 1 | 2 | 3)}
                className="bg-background border-input w-full rounded-md border px-3 py-2"
              >
                <option value={1}>Tier 1</option>
                <option value={2}>Tier 2</option>
                <option value={3}>Tier 3</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="monthlyTopUp">Monthly Top-up (USD)</Label>
              <Input
                id="monthlyTopUp"
                type="number"
                min={0}
                step={1}
                value={monthlyTopUpDollars}
                onChange={e => setMonthlyTopUpDollars(Number(e.target.value))}
              />
              <p className="text-muted-foreground text-sm">
                Amount to top up to each month if balance falls below
              </p>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="addInitialGrant"
                checked={addInitialGrant}
                onCheckedChange={checked => setAddInitialGrant(checked === true)}
              />
              <Label htmlFor="addInitialGrant" className="cursor-pointer">
                Add initial grant in this amount
              </Label>
            </div>

            <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-sm">
              <p className="mb-2 font-medium">This will:</p>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5">
                <li>Set the organization plan to Enterprise</li>
                <li>Disable seat requirements</li>
                <li>Suppress trial messaging</li>
                {addInitialGrant && monthlyTopUpDollars > 0 && (
                  <li>Grant ${monthlyTopUpDollars} in initial credits</li>
                )}
                <li>Set ${monthlyTopUpDollars}/month as the top-up amount</li>
                <li className="font-medium text-green-400">No email will be sent</li>
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmAdd} disabled={addToOssMutation.isPending}>
              {addToOssMutation.isPending ? 'Adding...' : 'Add to OSS Program'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type SortField =
  | 'organizationName'
  | 'email'
  | 'hasKiloAccount'
  | 'hasGitHubIntegration'
  | 'hasCodeReviewsEnabled'
  | 'isOnboardingComplete'
  | 'hasCompletedCodeReview'
  | 'lastCodeReviewDate'
  | 'tier'
  | 'monthlyCreditsUsd'
  | 'createdAt';

type SortDirection = 'asc' | 'desc';

type Filters = {
  search: string;
  hasKiloAccount: 'all' | 'yes' | 'no';
  hasGitHubIntegration: 'all' | 'yes' | 'no';
  hasCodeReviewsEnabled: 'all' | 'yes' | 'no';
  isOnboardingComplete: 'all' | 'yes' | 'no';
  tier: 'all' | 1 | 2 | 3;
};

function getTierName(tier: number | null): string {
  if (tier === 1) return 'Premier';
  if (tier === 2) return 'Growth';
  if (tier === 3) return 'Seed';
  return 'Unknown';
}

function SponsorshipsTable() {
  const trpc = useTRPC();

  const { data, isLoading, error } = useQuery(
    trpc.admin.ossSponsorship.listOssSponsorships.queryOptions()
  );

  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [filters, setFilters] = useState<Filters>({
    search: '',
    hasKiloAccount: 'all',
    hasGitHubIntegration: 'all',
    hasCodeReviewsEnabled: 'all',
    isOnboardingComplete: 'all',
    tier: 'all',
  });

  const sponsorships = useMemo(() => data ?? [], [data]);

  // Filter and sort sponsorships
  const filteredAndSortedSponsorships = useMemo(() => {
    let result = [...sponsorships];

    // Apply filters
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      result = result.filter(
        s =>
          s.organizationName.toLowerCase().includes(searchLower) ||
          (s.email && s.email.toLowerCase().includes(searchLower)) ||
          s.organizationId.toLowerCase().includes(searchLower)
      );
    }

    if (filters.hasKiloAccount !== 'all') {
      result = result.filter(s =>
        filters.hasKiloAccount === 'yes' ? s.hasKiloAccount : !s.hasKiloAccount
      );
    }

    if (filters.hasGitHubIntegration !== 'all') {
      result = result.filter(s =>
        filters.hasGitHubIntegration === 'yes' ? s.hasGitHubIntegration : !s.hasGitHubIntegration
      );
    }

    if (filters.hasCodeReviewsEnabled !== 'all') {
      result = result.filter(s =>
        filters.hasCodeReviewsEnabled === 'yes' ? s.hasCodeReviewsEnabled : !s.hasCodeReviewsEnabled
      );
    }

    if (filters.isOnboardingComplete !== 'all') {
      result = result.filter(s =>
        filters.isOnboardingComplete === 'yes' ? s.isOnboardingComplete : !s.isOnboardingComplete
      );
    }

    if (filters.tier !== 'all') {
      result = result.filter(s => s.tier === filters.tier);
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'organizationName':
          comparison = a.organizationName.localeCompare(b.organizationName);
          break;
        case 'email':
          comparison = (a.email || '').localeCompare(b.email || '');
          break;
        case 'hasKiloAccount':
          comparison = Number(a.hasKiloAccount) - Number(b.hasKiloAccount);
          break;
        case 'hasGitHubIntegration':
          comparison = Number(a.hasGitHubIntegration) - Number(b.hasGitHubIntegration);
          break;
        case 'hasCodeReviewsEnabled':
          comparison = Number(a.hasCodeReviewsEnabled) - Number(b.hasCodeReviewsEnabled);
          break;
        case 'isOnboardingComplete':
          comparison = Number(a.isOnboardingComplete) - Number(b.isOnboardingComplete);
          break;
        case 'hasCompletedCodeReview':
          comparison = Number(a.hasCompletedCodeReview) - Number(b.hasCompletedCodeReview);
          break;
        case 'lastCodeReviewDate':
          comparison =
            new Date(a.lastCodeReviewDate || 0).getTime() -
            new Date(b.lastCodeReviewDate || 0).getTime();
          break;
        case 'tier':
          comparison = (a.tier || 0) - (b.tier || 0);
          break;
        case 'monthlyCreditsUsd':
          comparison = (a.monthlyCreditsUsd || 0) - (b.monthlyCreditsUsd || 0);
          break;
        case 'createdAt':
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [sponsorships, filters, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="ml-1 h-4 w-4 opacity-50" />;
    }
    return sortDirection === 'asc' ? (
      <ArrowUp className="ml-1 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-1 h-4 w-4" />
    );
  };

  const handleExportCsv = () => {
    const headers = [
      'Organization Name',
      'Organization ID',
      'Owner Email',
      'Kilo User ID',
      'Has Kilo Account',
      'GitHub Integration',
      'Code Reviews Enabled',
      'Onboarding Complete',
      'Has Completed Code Review',
      'Last Code Review Date',
      'Tier',
      'Monthly Credits (USD)',
      'Current Balance (USD)',
      'Created At',
    ];

    const rows = filteredAndSortedSponsorships.map(s => [
      `"${s.organizationName.replace(/"/g, '""')}"`,
      s.organizationId,
      s.email || '',
      s.kiloUserId || '',
      s.hasKiloAccount ? 'Yes' : 'No',
      s.hasGitHubIntegration ? 'Yes' : 'No',
      s.hasCodeReviewsEnabled ? 'Yes' : 'No',
      s.isOnboardingComplete ? 'Yes' : 'No',
      s.hasCompletedCodeReview ? 'Yes' : 'No',
      s.lastCodeReviewDate ? new Date(s.lastCodeReviewDate).toISOString() : '',
      getTierName(s.tier),
      s.monthlyCreditsUsd?.toFixed(2) || '0',
      s.currentBalanceUsd?.toFixed(2) || '0',
      new Date(s.createdAt).toISOString(),
    ]);

    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    downloadCsv(csvContent, `oss-sponsorships-${new Date().toISOString().split('T')[0]}.csv`);
    toast.success(`Exported ${filteredAndSortedSponsorships.length} sponsorships`);
  };

  const hasActiveFilters =
    filters.search !== '' ||
    filters.hasKiloAccount !== 'all' ||
    filters.hasGitHubIntegration !== 'all' ||
    filters.hasCodeReviewsEnabled !== 'all' ||
    filters.isOnboardingComplete !== 'all' ||
    filters.tier !== 'all';

  const clearFilters = () => {
    setFilters({
      search: '',
      hasKiloAccount: 'all',
      hasGitHubIntegration: 'all',
      hasCodeReviewsEnabled: 'all',
      isOnboardingComplete: 'all',
      tier: 'all',
    });
  };

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load sponsorships</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>OSS Sponsorships</CardTitle>
            <CardDescription>
              {filteredAndSortedSponsorships.length === sponsorships.length
                ? `${sponsorships.length} total`
                : `${filteredAndSortedSponsorships.length} of ${sponsorships.length} shown`}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={isLoading || filteredAndSortedSponsorships.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[200px] flex-1">
            <Input
              type="text"
              placeholder="Search by name, email, or ID..."
              value={filters.search}
              onChange={e => setFilters(prev => ({ ...prev, search: e.target.value }))}
            />
          </div>
          <select
            value={filters.hasKiloAccount}
            onChange={e =>
              setFilters(prev => ({
                ...prev,
                hasKiloAccount: e.target.value as Filters['hasKiloAccount'],
              }))
            }
            className="bg-background border-input rounded-md border px-3 py-2 text-sm"
          >
            <option value="all">Kilo Account: All</option>
            <option value="yes">Has Kilo Account</option>
            <option value="no">No Kilo Account</option>
          </select>
          <select
            value={filters.hasGitHubIntegration}
            onChange={e =>
              setFilters(prev => ({
                ...prev,
                hasGitHubIntegration: e.target.value as Filters['hasGitHubIntegration'],
              }))
            }
            className="bg-background border-input rounded-md border px-3 py-2 text-sm"
          >
            <option value="all">GitHub: All</option>
            <option value="yes">GitHub Connected</option>
            <option value="no">No GitHub</option>
          </select>
          <select
            value={filters.hasCodeReviewsEnabled}
            onChange={e =>
              setFilters(prev => ({
                ...prev,
                hasCodeReviewsEnabled: e.target.value as Filters['hasCodeReviewsEnabled'],
              }))
            }
            className="bg-background border-input rounded-md border px-3 py-2 text-sm"
          >
            <option value="all">Code Reviews: All</option>
            <option value="yes">Code Reviews Enabled</option>
            <option value="no">No Code Reviews</option>
          </select>
          <select
            value={filters.isOnboardingComplete}
            onChange={e =>
              setFilters(prev => ({
                ...prev,
                isOnboardingComplete: e.target.value as Filters['isOnboardingComplete'],
              }))
            }
            className="bg-background border-input rounded-md border px-3 py-2 text-sm"
          >
            <option value="all">Onboarding: All</option>
            <option value="yes">Onboarding Complete</option>
            <option value="no">Not Complete</option>
          </select>
          <select
            value={filters.tier}
            onChange={e =>
              setFilters(prev => ({
                ...prev,
                tier: e.target.value === 'all' ? 'all' : (Number(e.target.value) as 1 | 2 | 3),
              }))
            }
            className="bg-background border-input rounded-md border px-3 py-2 text-sm"
          >
            <option value="all">Tier: All</option>
            <option value="1">Premier</option>
            <option value="2">Growth</option>
            <option value="3">Seed</option>
          </select>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="mr-1 h-4 w-4" />
              Clear
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="text-muted-foreground py-8 text-center">Loading sponsorships...</div>
        ) : sponsorships.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">No OSS sponsorships found</div>
        ) : filteredAndSortedSponsorships.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">
            No sponsorships match your filters
          </div>
        ) : (
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('organizationName')}
                  >
                    <div className="flex items-center">
                      Organization Name
                      {getSortIcon('organizationName')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('email')}
                  >
                    <div className="flex items-center">
                      Owner Email
                      {getSortIcon('email')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('hasKiloAccount')}
                  >
                    <div className="flex items-center">
                      Kilo Account
                      {getSortIcon('hasKiloAccount')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('hasGitHubIntegration')}
                  >
                    <div className="flex items-center">
                      GitHub
                      {getSortIcon('hasGitHubIntegration')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('hasCodeReviewsEnabled')}
                  >
                    <div className="flex items-center">
                      Code Reviews
                      {getSortIcon('hasCodeReviewsEnabled')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('isOnboardingComplete')}
                  >
                    <div className="flex items-center">
                      Onboarding
                      {getSortIcon('isOnboardingComplete')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('hasCompletedCodeReview')}
                  >
                    <div className="flex items-center">
                      Completed Review
                      {getSortIcon('hasCompletedCodeReview')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('lastCodeReviewDate')}
                  >
                    <div className="flex items-center">
                      Last Review Date
                      {getSortIcon('lastCodeReviewDate')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('tier')}
                  >
                    <div className="flex items-center">
                      Tier
                      {getSortIcon('tier')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('monthlyCreditsUsd')}
                  >
                    <div className="flex items-center">
                      Monthly Credits
                      {getSortIcon('monthlyCreditsUsd')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="hover:bg-muted/50 cursor-pointer select-none"
                    onClick={() => handleSort('createdAt')}
                  >
                    <div className="flex items-center">
                      Created At
                      {getSortIcon('createdAt')}
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAndSortedSponsorships.map(sponsorship => (
                  <TableRow key={sponsorship.organizationId}>
                    <TableCell>
                      <div className="space-y-1">
                        <Link
                          href={`/admin/organizations/${sponsorship.organizationId}`}
                          className="font-medium text-blue-400 hover:underline"
                        >
                          {sponsorship.organizationName}
                        </Link>
                        <p className="text-muted-foreground font-mono text-xs">
                          {sponsorship.organizationId.slice(0, 8)}...
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {sponsorship.email ? (
                        sponsorship.kiloUserId ? (
                          <Link
                            href={`/admin/users/${sponsorship.kiloUserId}`}
                            className="text-blue-400 hover:underline"
                          >
                            {sponsorship.email}
                          </Link>
                        ) : (
                          sponsorship.email
                        )
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {sponsorship.hasKiloAccount ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-500" />
                      )}
                    </TableCell>
                    <TableCell>
                      {sponsorship.hasGitHubIntegration ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-500" />
                      )}
                    </TableCell>
                    <TableCell>
                      {sponsorship.hasCodeReviewsEnabled ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-500" />
                      )}
                    </TableCell>
                    <TableCell>
                      {sponsorship.isOnboardingComplete ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-500" />
                      )}
                    </TableCell>
                    <TableCell>
                      {sponsorship.hasCompletedCodeReview ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-500" />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {sponsorship.lastCodeReviewDate
                        ? new Date(sponsorship.lastCodeReviewDate).toLocaleDateString()
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{getTierName(sponsorship.tier)}</Badge>
                    </TableCell>
                    <TableCell>
                      {sponsorship.monthlyCreditsUsd !== null &&
                      sponsorship.monthlyCreditsUsd > 0 ? (
                        <span className="font-mono">
                          ${sponsorship.monthlyCreditsUsd.toFixed(0)}/mo
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(sponsorship.createdAt).toLocaleDateString()}
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

function ManualEntrySection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [githubUrl, setGithubUrl] = useState('');
  const [email, setEmail] = useState('');
  const [creditsDollars, setCreditsDollars] = useState<number>(0);
  const [tier, setTier] = useState<1 | 2 | 3>(1);

  const repoName = useMemo(() => extractRepoName(githubUrl), [githubUrl]);
  const isGithubUrlValid = githubUrl === '' || repoName !== null;
  const isEmailValid = email === '' || email.includes('@');
  const isCreditsValid = creditsDollars >= 0;
  const canSubmit = githubUrl !== '' && repoName !== null && email.includes('@') && isCreditsValid;

  const processOssCsvMutation = useMutation(
    trpc.admin.ossSponsorship.processOssCsv.mutationOptions({
      onSuccess: results => {
        const result = results[0];
        if (result?.success) {
          toast.success(`Successfully created sponsorship for ${repoName}`);
          setGithubUrl('');
          setEmail('');
          setCreditsDollars(0);
          setTier(1);
          void queryClient.invalidateQueries({
            queryKey: trpc.admin.ossSponsorship.listOssSponsorships.queryKey(),
          });
        } else {
          toast.error(result?.error ?? 'Failed to create sponsorship');
        }
      },
      onError: error => {
        toast.error(error.message || 'Failed to create sponsorship');
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    processOssCsvMutation.mutate([{ githubUrl: githubUrl.match(/^https?:\/\//) ? githubUrl : `https://${githubUrl}`, email, creditsDollars, tier }]);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="h-5 w-5" />
          Manual Entry
        </CardTitle>
        <CardDescription>Add a single OSS sponsorship manually</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="manual-github-url">GitHub URL</Label>
              <Input
                id="manual-github-url"
                type="text"
                placeholder="https://github.com/owner/repo"
                value={githubUrl}
                onChange={e => setGithubUrl(e.target.value)}
              />
              {githubUrl && !isGithubUrlValid && (
                <p className="text-destructive text-sm">Invalid GitHub repository URL</p>
              )}
              {repoName && (
                <p className="text-muted-foreground text-sm">
                  Organization name: <span className="font-medium">{repoName}</span>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-email">Email</Label>
              <Input
                id="manual-email"
                type="text"
                placeholder="user@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
              {email && !isEmailValid && (
                <p className="text-destructive text-sm">Invalid email address</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-credits">Credits (USD)</Label>
              <Input
                id="manual-credits"
                type="number"
                min={0}
                step={1}
                value={creditsDollars}
                onChange={e => setCreditsDollars(Number(e.target.value))}
              />
              {!isCreditsValid && (
                <p className="text-destructive text-sm">Credits must be non-negative</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-tier">Tier</Label>
              <select
                id="manual-tier"
                value={tier}
                onChange={e => setTier(Number(e.target.value) as 1 | 2 | 3)}
                className="bg-background border-input w-full rounded-md border px-3 py-2"
              >
                <option value={1}>Tier 1 — Premier</option>
                <option value={2}>Tier 2 — Growth</option>
                <option value={3}>Tier 3 — Seed</option>
              </select>
            </div>
          </div>
          <Button type="submit" disabled={!canSubmit || processOssCsvMutation.isPending}>
            {processOssCsvMutation.isPending ? 'Creating...' : 'Create Sponsorship'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function OssSponsorshipPage() {
  return (
    <div className="container mx-auto max-w-6xl space-y-8 p-8">
      <div>
        <h1 className="text-2xl font-bold">OSS Sponsorship Management</h1>
        <p className="text-muted-foreground">Import and manage OSS sponsorships</p>
      </div>

      <CsvUploadSection />
      <ManualEntrySection />
      <AddExistingOrgSection />
      <SponsorshipsTable />
    </div>
  );
}
