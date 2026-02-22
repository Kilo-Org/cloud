'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search, Cloud, Terminal, Puzzle, Bot } from 'lucide-react';
import type { SessionsListItem } from '@/components/cloud-agent/SessionsList';
import { SessionsList } from '@/components/cloud-agent/SessionsList';
import { extractRepoFromGitUrl } from '@/components/cloud-agent/store/db-session-atoms';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';
import { OpenInCliButton } from '@/app/share/[shareId]/open-in-cli-button';
import { CopyableCommand } from '@/components/CopyableCommand';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { PageContainer } from '@/components/layouts/PageContainer';

/** Platform filter options matching the badge logic in SessionsList */
const PLATFORM_OPTIONS: readonly {
  value: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}[] = [
  { value: 'all', label: 'All Platforms' },
  { value: 'cloud-agent', label: 'Cloud', icon: Cloud },
  { value: 'cli', label: 'CLI', icon: Terminal },
  { value: 'agent-manager', label: 'Agent Manager', icon: Bot },
  { value: 'extension', label: 'Extension', icon: Puzzle },
];

type PlatformFilterValue = 'all' | 'cloud-agent' | 'cli' | 'agent-manager' | 'extension';

export function SessionsPageContent() {
  const trpc = useTRPC();
  const pathname = usePathname();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilterValue>('all');
  const [includeSubSessions, setIncludeSubSessions] = useState(false);
  type SessionWithSource = SessionsListItem & { source: 'v1' | 'v2' };
  const [selectedSession, setSelectedSession] = useState<SessionWithSource | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Debounce search query (300ms delay)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Determine if we're in an organization context
  const organizationId = pathname.match(/^\/organizations\/([^/]+)/)?.[1];

  // When in organization context, OrganizationTrialWrapper already provides PageContainer
  const shouldUsePageContainer = !organizationId;

  const isSearching = debouncedSearchQuery.trim().length > 0;

  // Query for listing sessions (when not searching)
  // Order by updated_at and filter by organization and platform
  const { data: listData, isLoading: isListLoading } = useQuery(
    trpc.unifiedSessions.list.queryOptions({
      limit: 50,
      orderBy: 'updated_at',
      organizationId: organizationId ?? null,
      createdOnPlatform: platformFilter === 'all' ? undefined : platformFilter,
      includeSubSessions,
    })
  );

  // Query for searching sessions (uses debounced value)
  const { data: searchData, isLoading: isSearchLoading } = useQuery({
    ...trpc.unifiedSessions.search.queryOptions({
      search_string: debouncedSearchQuery.trim(),
      limit: 50,
      offset: 0,
      organizationId: organizationId ?? null,
      createdOnPlatform: platformFilter === 'all' ? undefined : platformFilter,
      includeSubSessions,
    }),
    enabled: isSearching,
  });

  // Convert API session to StoredSession format
  const convertToStoredSession = (session: {
    session_id: string;
    title: string;
    git_url: string | null;
    created_at: string;
    updated_at: string;
    created_on_platform: string;
    cloud_agent_session_id: string | null;
    source: 'v1' | 'v2';
  }): SessionWithSource => {
    const repository = extractRepoFromGitUrl(session.git_url) ?? null;
    const prompt = session.title || 'Untitled';

    return {
      createdAt: session.created_at,
      createdOnPlatform: session.created_on_platform,
      prompt,
      repository,
      sessionId: session.session_id,
      mode: '',
      source: session.source,
    };
  };

  // Get sessions based on search state
  const sessions = isSearching
    ? (searchData?.results || []).map(convertToStoredSession)
    : (listData?.cliSessions || []).map(convertToStoredSession);

  const isLoading = isSearching ? isSearchLoading : isListLoading;

  const handleSessionClick = (session: SessionWithSource) => {
    setSelectedSession(session);
    setIsDialogOpen(true);
  };

  const content = (
    <>
      {/* Header */}
      <div className="mb-6">
        <h1 className="mb-4 text-3xl font-bold">Sessions</h1>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              type="text"
              placeholder="Search sessions by title or ID..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select
            value={platformFilter}
            onValueChange={value => setPlatformFilter(value as PlatformFilterValue)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All Platforms" />
            </SelectTrigger>
            <SelectContent>
              {PLATFORM_OPTIONS.map(option => {
                const Icon = option.icon;
                return (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center gap-2">
                      {Icon && <Icon className="h-4 w-4" />}
                      {option.label}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select
            value={includeSubSessions ? 'all' : 'root'}
            onValueChange={value => setIncludeSubSessions(value === 'all')}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="root">Root sessions</SelectItem>
              <SelectItem value="all">All sessions</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Sessions List */}
      {isLoading ? (
        <div className="py-12 text-center">
          <p className="text-muted-foreground">Loading sessions...</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-muted-foreground">
            {isSearching ? 'No sessions found matching your search.' : 'No sessions yet.'}
          </p>
        </div>
      ) : (
        <SessionsList sessions={sessions} onSessionClick={handleSessionClick} />
      )}

      {/* Open In Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open Session</DialogTitle>
            <DialogDescription>Choose how you want to open this session.</DialogDescription>
          </DialogHeader>
          {selectedSession && (
            <div className="space-y-6">
              {/* Session Info */}
              <div className="bg-muted/50 space-y-2 rounded-lg p-4">
                <p className="text-sm">
                  <span className="font-medium">Session:</span> {selectedSession.prompt}
                </p>
                {selectedSession.repository && (
                  <p className="text-sm">
                    <span className="font-medium">Repository:</span> {selectedSession.repository}
                  </p>
                )}
                <p className="text-sm">
                  <span className="font-medium">ID:</span> {selectedSession.sessionId}
                </p>
              </div>

              {/* Open in Cloud Agent */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Open in Cloud Agent</h3>
                <Button asChild variant="outline" className="w-full justify-start gap-2">
                  <Link
                    href={
                      organizationId
                        ? `/organizations/${organizationId}/cloud/chat?sessionId=${selectedSession.sessionId}`
                        : `/cloud/chat?sessionId=${selectedSession.sessionId}`
                    }
                    onClick={() => setIsDialogOpen(false)}
                  >
                    <Cloud className="h-4 w-4" />
                    Continue in Cloud Agent
                  </Link>
                </Button>
              </div>

              {/* Fork Options */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Fork Session</h3>
                <p className="text-muted-foreground text-xs">
                  Fork this session to continue working on it in your editor or CLI
                </p>

                {selectedSession.source === 'v1' && (
                  <>
                    {/* Open in Editor (v1 only) */}
                    <div className="flex justify-center">
                      <OpenInEditorButton sessionId={selectedSession.sessionId} />
                    </div>

                    {/* Open in CLI (v1 only) */}
                    <div className="flex justify-center">
                      <OpenInCliButton command={`kilocode --fork ${selectedSession.sessionId}`} />
                    </div>

                    {/* Manual fork command (v1) */}
                    <div className="space-y-2">
                      <p className="text-muted-foreground text-xs">
                        Or use the fork command manually:
                      </p>
                      <CopyableCommand
                        command={`/session fork ${selectedSession.sessionId}`}
                        className="bg-muted rounded-md px-3 py-2 text-sm"
                      />
                    </div>
                  </>
                )}

                {selectedSession.source === 'v2' && (
                  <div className="space-y-2">
                    <p className="text-muted-foreground text-xs">
                      Use the CLI to fork this session:
                    </p>
                    <CopyableCommand
                      command={`kilo --session ${selectedSession.sessionId} --fork`}
                      className="bg-muted rounded-md px-3 py-2 text-sm"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );

  // When in organization context, skip PageContainer (OrganizationTrialWrapper provides it)
  if (!shouldUsePageContainer) {
    return content;
  }

  return <PageContainer>{content}</PageContainer>;
}
