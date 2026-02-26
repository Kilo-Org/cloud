'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { MessageBubble as V1MessageBubble } from '@/components/cloud-agent/MessageBubble';
import { MessageErrorBoundary as V1MessageErrorBoundary } from '@/components/cloud-agent/MessageErrorBoundary';
import { convertToCloudMessages } from '@/components/cloud-agent/store/db-session-atoms';
import { MessageBubble as V2MessageBubble } from '@/components/cloud-agent-next/MessageBubble';
import { MessageErrorBoundary as V2MessageErrorBoundary } from '@/components/cloud-agent-next/MessageErrorBoundary';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import {
  useAdminSessionTrace,
  useAdminSessionMessages,
  useAdminApiConversationHistory,
  useAdminResolveCloudAgentSession,
} from '@/app/admin/api/session-traces/hooks';
import { Search, User, Calendar, Globe, GitBranch, Loader2, Download } from 'lucide-react';
import type { CloudMessage, Message } from '@/components/cloud-agent/types';
import type { StoredMessage } from '@/components/cloud-agent-next/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SES_PREFIX = 'ses_';
const AGENT_PREFIX = 'agent_';

function convertToMessage(cloudMessage: CloudMessage): Message & {
  say?: string;
  ask?: string;
  metadata?: Record<string, unknown>;
  partial?: boolean;
} {
  const content = cloudMessage.text || cloudMessage.content || '';
  const timestamp = new Date(cloudMessage.ts).toISOString();
  const role =
    cloudMessage.type === 'user' ? 'user' : cloudMessage.type === 'system' ? 'system' : 'assistant';

  return {
    role,
    content,
    timestamp,
    toolExecutions: cloudMessage.toolExecutions,
    say: cloudMessage.say,
    ask: cloudMessage.ask,
    metadata: cloudMessage.metadata,
    partial: false,
  };
}

export function SessionTraceViewer() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionIdFromUrl = searchParams.get('sessionId');

  const [inputValue, setInputValue] = useState('');
  const [searchedSessionId, setSearchedSessionId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [resolvedFromAgent, setResolvedFromAgent] = useState<string | null>(null);

  const resolveQuery = useAdminResolveCloudAgentSession(pendingAgentId);

  // When the agent ID resolves, transition to the CLI session ID
  useEffect(() => {
    if (resolveQuery.data?.session_id && pendingAgentId) {
      const resolved = resolveQuery.data.session_id;
      setResolvedFromAgent(pendingAgentId);
      setPendingAgentId(null);
      setSearchedSessionId(resolved);
      router.replace(`/admin/session-traces?sessionId=${resolved}`);
    }
  }, [resolveQuery.data, pendingAgentId, router]);

  // Initialize from URL parameter on mount
  useEffect(() => {
    if (!sessionIdFromUrl) return;
    if (sessionIdFromUrl.startsWith(AGENT_PREFIX)) {
      setInputValue(sessionIdFromUrl);
      setPendingAgentId(sessionIdFromUrl);
      setSearchedSessionId(null);
    } else if (UUID_REGEX.test(sessionIdFromUrl) || sessionIdFromUrl.startsWith(SES_PREFIX)) {
      setInputValue(sessionIdFromUrl);
      setSearchedSessionId(sessionIdFromUrl);
    }
  }, [sessionIdFromUrl]);

  const sessionQuery = useAdminSessionTrace(searchedSessionId);
  const messagesQuery = useAdminSessionMessages(searchedSessionId);
  const apiHistoryQuery = useAdminApiConversationHistory(searchedSessionId);

  const handleSearch = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setValidationError('Please enter a session ID');
      return;
    }

    const isAgent = trimmed.startsWith(AGENT_PREFIX);
    if (!UUID_REGEX.test(trimmed) && !trimmed.startsWith(SES_PREFIX) && !isAgent) {
      setValidationError(
        'Invalid session ID. Expected a UUID, a v2 ID (ses_...), or a cloud agent session ID (agent_...)'
      );
      return;
    }

    setValidationError(null);
    setResolvedFromAgent(null);

    if (isAgent) {
      setPendingAgentId(trimmed);
      setSearchedSessionId(null);
    } else {
      setPendingAgentId(null);
      setSearchedSessionId(trimmed);
      router.replace(`/admin/session-traces?sessionId=${trimmed}`);
    }
  };

  const downloadJson = (data: unknown, filename: string) => {
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadSessionTrace = () => {
    if (sessionQuery.data) {
      downloadJson(sessionQuery.data, `session-trace-${searchedSessionId}.json`);
    }
  };

  const handleDownloadMessages = () => {
    if (messagesQuery.data?.messages) {
      downloadJson(messagesQuery.data.messages, `session-messages-${searchedSessionId}.json`);
    }
  };

  const handleDownloadApiHistory = () => {
    if (apiHistoryQuery.data?.history) {
      downloadJson(
        apiHistoryQuery.data.history,
        `api-conversation-history-${searchedSessionId}.json`
      );
    }
  };

  const isV2 = searchedSessionId ? isNewSession(searchedSessionId) : false;

  const v1Messages = useMemo(() => {
    if (!messagesQuery.data?.messages || messagesQuery.data.format === 'v2') return [];
    const cloudMessages = convertToCloudMessages(
      messagesQuery.data.messages as Array<Record<string, unknown>>
    );
    return cloudMessages.map(convertToMessage);
  }, [messagesQuery.data]);

  const v2Messages = useMemo(() => {
    if (!messagesQuery.data?.messages || messagesQuery.data.format !== 'v2') return [];
    // Server-side Zod validates minimal shape; full StoredMessage structure is
    // guaranteed by the session-ingest worker that originally created the data.
    return messagesQuery.data.messages as unknown as StoredMessage[];
  }, [messagesQuery.data]);

  const messageCount = isV2 ? v2Messages.length : v1Messages.length;

  const breadcrumbs = (
    <BreadcrumbItem>
      <BreadcrumbPage>Session Traces</BreadcrumbPage>
    </BreadcrumbItem>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Session Trace Viewer</CardTitle>
            <CardDescription>
              Enter a CLI session ID (UUID or ses_...) or a cloud agent session ID (agent_...) to
              view the full session trace
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="e.g., 550e8400-e29b-41d4-a716-446655440000, ses_abc123..., or agent_..."
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                className="font-mono"
              />
              <Button
                onClick={handleSearch}
                disabled={sessionQuery.isLoading || resolveQuery.isLoading}
              >
                {sessionQuery.isLoading || resolveQuery.isLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                {resolveQuery.isLoading
                  ? 'Resolving...'
                  : sessionQuery.isLoading
                    ? 'Loading...'
                    : 'Search'}
              </Button>
            </div>
            {validationError && <p className="mt-2 text-sm text-red-500">{validationError}</p>}
          </CardContent>
        </Card>

        {pendingAgentId && resolveQuery.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {resolveQuery.error?.message || 'Could not resolve cloud agent session ID'}
            </AlertDescription>
          </Alert>
        )}

        {resolvedFromAgent && (
          <Alert>
            <AlertDescription>
              Resolved from cloud agent session{' '}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-sm">
                {resolvedFromAgent}
              </code>
            </AlertDescription>
          </Alert>
        )}

        {sessionQuery.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {sessionQuery.error?.message || 'Session not found'}
            </AlertDescription>
          </Alert>
        )}

        {sessionQuery.data && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Session Details</CardTitle>
                <Button variant="outline" size="sm" onClick={handleDownloadSessionTrace}>
                  <Download className="mr-2 h-4 w-4" />
                  Download JSON
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="flex items-center gap-2">
                <User className="text-muted-foreground h-4 w-4" />
                <span className="text-sm">
                  {sessionQuery.data.user?.name || 'Unknown'} (
                  {sessionQuery.data.user?.email || sessionQuery.data.kilo_user_id})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Title:</span>
                <span className="text-sm">{sessionQuery.data.title || 'Untitled'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Globe className="text-muted-foreground h-4 w-4" />
                <span className="text-sm">{sessionQuery.data.created_on_platform}</span>
              </div>
              {sessionQuery.data.git_url && (
                <div className="flex items-center gap-2">
                  <GitBranch className="text-muted-foreground h-4 w-4" />
                  <span className="font-mono text-sm">{sessionQuery.data.git_url}</span>
                </div>
              )}
              {sessionQuery.data.git_branch && (
                <div className="flex items-center gap-2">
                  <GitBranch className="text-muted-foreground h-4 w-4" />
                  <span className="font-mono text-sm">{sessionQuery.data.git_branch}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Calendar className="text-muted-foreground h-4 w-4" />
                <span className="text-sm">
                  Created: {new Date(sessionQuery.data.created_at).toLocaleString()}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="text-muted-foreground h-4 w-4" />
                <span className="text-sm">
                  Updated: {new Date(sessionQuery.data.updated_at).toLocaleString()}
                </span>
              </div>
              {sessionQuery.data.last_mode && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Mode:</span>
                  <span className="text-sm">{sessionQuery.data.last_mode}</span>
                </div>
              )}
              {sessionQuery.data.last_model && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Model:</span>
                  <span className="font-mono text-sm">{sessionQuery.data.last_model}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {sessionQuery.data && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Messages ({messageCount})</CardTitle>
                {messagesQuery.data?.messages && (
                  <Button variant="outline" size="sm" onClick={handleDownloadMessages}>
                    <Download className="mr-2 h-4 w-4" />
                    Download JSON
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {messagesQuery.isLoading ? (
                <div className="text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading messages...</span>
                </div>
              ) : messageCount === 0 ? (
                <p className="text-muted-foreground">No messages in this session</p>
              ) : isV2 ? (
                <div className="space-y-2">
                  {v2Messages.map((msg, index) => (
                    <V2MessageErrorBoundary key={`${msg.info.id}-${index}`}>
                      <V2MessageBubble message={msg} isStreaming={false} />
                    </V2MessageErrorBoundary>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {v1Messages.map((msg, index) => (
                    <V1MessageErrorBoundary key={`${msg.role}-${msg.timestamp}-${index}`}>
                      <V1MessageBubble message={msg} isStreaming={false} />
                    </V1MessageErrorBoundary>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {sessionQuery.data && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Raw API Conversation History</CardTitle>
                {apiHistoryQuery.data?.history && (
                  <Button variant="outline" size="sm" onClick={handleDownloadApiHistory}>
                    <Download className="mr-2 h-4 w-4" />
                    Download JSON
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {apiHistoryQuery.isLoading ? (
                <div className="text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading API conversation history...</span>
                </div>
              ) : !apiHistoryQuery.data?.history ? (
                <p className="text-muted-foreground">No API conversation history available</p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Raw API conversation history available for download
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AdminPage>
  );
}
