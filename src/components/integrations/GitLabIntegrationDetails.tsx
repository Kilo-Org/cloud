'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CheckCircle2,
  XCircle,
  GitBranch,
  Settings,
  ExternalLink,
  RefreshCw,
  Server,
  Loader2,
  AlertCircle,
  Key,
} from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useState, useRef } from 'react';
import { useGitLabQueries } from './GitLabContext';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

type GitLabIntegrationDetailsProps = {
  organizationId?: string;
  organizationName?: string;
  success?: boolean;
  error?: string;
};

type InstanceValidationState = {
  status: 'idle' | 'validating' | 'valid' | 'invalid';
  version?: string;
  enterprise?: boolean;
  error?: string;
};

type PATValidationState = {
  status: 'idle' | 'validating' | 'valid' | 'invalid';
  user?: {
    id: number;
    username: string;
    name: string;
  };
  tokenInfo?: {
    id: number;
    name: string;
    scopes: string[];
    expiresAt: string | null;
    active: boolean;
    lastUsedAt: string | null;
  };
  error?: string;
  missingScopes?: string[];
  warnings?: string[];
};

export function GitLabIntegrationDetails({
  organizationId,
  success,
  error,
}: GitLabIntegrationDetailsProps) {
  // Shared state between OAuth and PAT
  const [instanceUrl, setInstanceUrl] = useState('https://gitlab.com');
  const [showSelfHosted, setShowSelfHosted] = useState(false);
  const [instanceValidation, setInstanceValidation] = useState<InstanceValidationState>({
    status: 'idle',
  });

  // OAuth-specific state
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  // PAT-specific state
  const [connectionMethod, setConnectionMethod] = useState<'oauth' | 'pat'>('oauth');
  const [patToken, setPatToken] = useState('');
  const [patValidation, setPATValidation] = useState<PATValidationState>({
    status: 'idle',
  });

  const trpc = useTRPC();
  const validationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const patValidationTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isSelfHostedInput = Boolean(
    showSelfHosted && instanceUrl && instanceUrl !== 'https://gitlab.com' && instanceUrl !== ''
  );

  const { queries, mutations } = useGitLabQueries();

  // Instance validation mutation (shared between OAuth and PAT)
  const { mutate: validateInstanceMutate } = useMutation(
    trpc.gitlab.validateInstance.mutationOptions({
      onSuccess: result => {
        if (result.valid) {
          setInstanceValidation({
            status: 'valid',
            version: result.version,
            enterprise: result.enterprise,
            error: result.error, // May have a warning even if valid
          });
        } else {
          setInstanceValidation({
            status: 'invalid',
            error: result.error,
          });
        }
      },
      onError: err => {
        setInstanceValidation({
          status: 'invalid',
          error: err.message || 'Failed to validate GitLab instance',
        });
      },
    })
  );

  // PAT validation mutation
  const { mutate: validatePATMutate } = useMutation(
    trpc.gitlab.validatePAT.mutationOptions({
      onSuccess: result => {
        if (result.valid && result.user) {
          setPATValidation({
            status: 'valid',
            user: result.user,
            tokenInfo: result.tokenInfo,
            warnings: result.warnings,
          });
        } else {
          setPATValidation({
            status: 'invalid',
            error: result.error,
            missingScopes: result.missingScopes,
          });
        }
      },
      onError: err => {
        setPATValidation({
          status: 'invalid',
          error: err.message || 'Failed to validate Personal Access Token',
        });
      },
    })
  );

  // Connect with PAT mutation
  const { mutate: connectWithPATMutate, isPending: isConnectingWithPAT } = useMutation(
    trpc.gitlab.connectWithPAT.mutationOptions({
      onSuccess: () => {
        toast.success('GitLab connected successfully!');
        // Reset PAT form
        setPatToken('');
        setPATValidation({ status: 'idle' });
        setConnectionMethod('oauth');
        // Reload the page to refresh the installation data
        window.location.reload();
      },
      onError: err => {
        toast.error('Failed to connect', { description: err.message });
      },
    })
  );

  // PAT validation effect (with debounce)
  useEffect(() => {
    // Clear any pending validation
    if (patValidationTimeoutRef.current) {
      clearTimeout(patValidationTimeoutRef.current);
    }

    // Only validate if we have a token that looks valid (at least 20 chars for GitLab PATs)
    if (!patToken || patToken.length < 20) {
      if (patToken.length > 0 && patToken.length < 20) {
        setPATValidation({
          status: 'idle',
        });
      } else {
        setPATValidation({ status: 'idle' });
      }
      return;
    }

    setPATValidation({ status: 'validating' });

    patValidationTimeoutRef.current = setTimeout(() => {
      // Use the shared instanceUrl for PAT validation
      validatePATMutate({ token: patToken, instanceUrl });
    }, 500);

    return () => {
      if (patValidationTimeoutRef.current) {
        clearTimeout(patValidationTimeoutRef.current);
      }
    };
  }, [patToken, instanceUrl, validatePATMutate]);

  // Validate instance URL when it changes (with debounce) - shared between OAuth and PAT
  useEffect(() => {
    // Clear any pending validation
    if (validationTimeoutRef.current) {
      clearTimeout(validationTimeoutRef.current);
    }

    if (!isSelfHostedInput) {
      setInstanceValidation({ status: 'idle' });
      return;
    }

    // Basic URL validation before making the request
    try {
      new URL(instanceUrl);
    } catch {
      setInstanceValidation({
        status: 'invalid',
        error: 'Invalid URL format',
      });
      return;
    }

    setInstanceValidation({ status: 'validating' });

    validationTimeoutRef.current = setTimeout(() => {
      validateInstanceMutate({ instanceUrl });
    }, 500);

    return () => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
    };
  }, [instanceUrl, isSelfHostedInput, validateInstanceMutate]);

  const { data: installationData, isLoading } = queries.getInstallation();

  const isDisconnecting = mutations.disconnect.isPending;

  useEffect(() => {
    if (success) {
      toast.success('GitLab connected successfully!');
    }
    if (error) {
      const errorMessages: Record<string, string> = {
        missing_code: 'Authorization code missing from GitLab',
        connection_failed: 'Failed to connect to GitLab',
        oauth_init_failed: 'Failed to initiate GitLab OAuth',
      };
      toast.error(errorMessages[error] || `Connection failed: ${error}`);
    }
  }, [success, error]);

  const handleConnect = () => {
    if (isSelfHostedInput && (!clientId || !clientSecret)) {
      toast.error('Please enter your GitLab Client ID and Secret');
      return;
    }

    const params = new URLSearchParams();
    if (organizationId) {
      params.set('organizationId', organizationId);
    }
    if (instanceUrl && instanceUrl !== 'https://gitlab.com') {
      params.set('instanceUrl', instanceUrl);
    }
    if (isSelfHostedInput && clientId && clientSecret) {
      params.set('clientId', clientId);
      params.set('clientSecret', clientSecret);
    }

    window.location.href = `/api/integrations/gitlab/connect?${params.toString()}`;
  };

  const handleDisconnect = () => {
    if (confirm('Are you sure you want to disconnect GitLab?')) {
      mutations.disconnect.mutate(undefined, {
        onSuccess: () => {
          toast.success('GitLab disconnected');
        },
        onError: (err: { message: string }) => {
          toast.error('Failed to disconnect', {
            description: err.message,
          });
        },
      });
    }
  };

  const handleRefresh = () => {
    if (!installationData?.installation?.id) return;

    mutations.refreshRepositories.mutate(
      { integrationId: installationData.installation.id },
      {
        onSuccess: () => {
          toast.success('Repositories refreshed');
        },
        onError: (err: { message: string }) => {
          toast.error('Failed to refresh repositories', {
            description: err.message,
          });
        },
      }
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="animate-pulse space-y-4">
            <div className="bg-muted h-20 rounded" />
            <div className="bg-muted h-32 rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const isConnected = installationData?.installed;
  const installation = installationData?.installation;
  const gitlabInstanceUrl = installation?.instanceUrl || 'https://gitlab.com';
  const isSelfHosted = gitlabInstanceUrl !== 'https://gitlab.com';
  const authType = (installation as { authType?: 'oauth' | 'pat' } | null)?.authType ?? 'oauth';

  return (
    <div className="space-y-6">
      {/* Integration Status Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <GitBranch className="h-5 w-5" />
                GitLab Integration
                {isSelfHosted && (
                  <Badge variant="outline" className="ml-2">
                    <Server className="mr-1 h-3 w-3" />
                    Self-hosted
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Connect your GitLab repositories for AI-powered code reviews and automated workflows
              </CardDescription>
            </div>
            {isConnected ? (
              <Badge variant="default" className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                Not Connected
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isConnected && installation ? (
            <>
              {/* Connection Details */}
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Account:</span>
                  <span className="text-sm">{installation.accountLogin}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Auth Method:</span>
                  <Badge variant={authType === 'pat' ? 'secondary' : 'outline'}>
                    {authType === 'pat' ? (
                      <>
                        <Key className="mr-1 h-3 w-3" />
                        Personal Access Token
                      </>
                    ) : (
                      <>
                        <GitBranch className="mr-1 h-3 w-3" />
                        OAuth
                      </>
                    )}
                  </Badge>
                </div>
                {isSelfHosted && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Instance:</span>
                    <span className="text-sm">{gitlabInstanceUrl}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Repository Access:</span>
                  <Badge variant="outline">All accessible projects</Badge>
                </div>
                {installation.repositories &&
                  Array.isArray(installation.repositories) &&
                  installation.repositories.length > 0 && (
                    <div className="space-y-2">
                      <span className="text-sm font-medium">
                        Projects ({installation.repositories.length}):
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {installation.repositories
                          .slice(0, 10)
                          .map((repo: { id: number; full_name: string }) => (
                            <Badge key={repo.id} variant="secondary">
                              {repo.full_name}
                            </Badge>
                          ))}
                        {installation.repositories.length > 10 && (
                          <Badge variant="outline">
                            +{installation.repositories.length - 10} more
                          </Badge>
                        )}
                      </div>
                    </div>
                  )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Connected:</span>
                  <span className="text-sm">
                    {new Date(installation.installedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    // For PAT connections, link to Access Tokens page; for OAuth, link to Applications
                    const targetUrl =
                      authType === 'pat'
                        ? `${gitlabInstanceUrl}/-/user_settings/personal_access_tokens`
                        : `${gitlabInstanceUrl}/-/profile/applications`;
                    window.open(targetUrl, '_blank');
                  }}
                >
                  {authType === 'pat' ? (
                    <Key className="mr-2 h-4 w-4" />
                  ) : (
                    <Settings className="mr-2 h-4 w-4" />
                  )}
                  {authType === 'pat' ? 'Manage Access Token' : 'Manage on GitLab'}
                  <ExternalLink className="ml-2 h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  onClick={handleRefresh}
                  disabled={mutations.refreshRepositories.isPending}
                >
                  <RefreshCw
                    className={`mr-2 h-4 w-4 ${mutations.refreshRepositories.isPending ? 'animate-spin' : ''}`}
                  />
                  {mutations.refreshRepositories.isPending ? 'Refreshing...' : 'Refresh Projects'}
                </Button>
                <Button variant="destructive" onClick={handleDisconnect} disabled={isDisconnecting}>
                  {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* Not Connected State */}
              <Alert>
                <AlertDescription>
                  Connect your GitLab account to integrate your repositories with Kilo Code. Enable
                  AI-powered code reviews on merge requests and other intelligent workflows for your
                  projects.
                </AlertDescription>
              </Alert>

              <div className="space-y-2 rounded-lg border p-4">
                <h4 className="font-medium">What happens when you connect:</h4>
                <ul className="text-muted-foreground space-y-1 text-sm">
                  <li>✓ Access your GitLab projects and repositories</li>
                  <li>✓ Enable AI-powered code reviews on merge requests</li>
                  <li>✓ Configure intelligent agents for your repositories</li>
                  <li>✓ Seamless integration with your existing GitLab workflows</li>
                </ul>
              </div>

              {/* Connection Method Toggle */}
              <div className="space-y-4">
                <div className="flex gap-2">
                  <Button
                    variant={connectionMethod === 'oauth' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setConnectionMethod('oauth')}
                  >
                    <GitBranch className="mr-2 h-4 w-4" />
                    OAuth
                  </Button>
                  <Button
                    variant={connectionMethod === 'pat' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setConnectionMethod('pat')}
                  >
                    <Key className="mr-2 h-4 w-4" />
                    Personal Access Token
                  </Button>
                </div>

                {/* Self-hosted GitLab option - shared between OAuth and PAT */}
                <div className="space-y-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowSelfHosted(!showSelfHosted);
                      if (showSelfHosted) {
                        // Reset to gitlab.com when hiding
                        setInstanceUrl('https://gitlab.com');
                        setInstanceValidation({ status: 'idle' });
                      }
                    }}
                    className="text-muted-foreground"
                  >
                    <Server className="mr-2 h-4 w-4" />
                    {showSelfHosted ? 'Hide' : 'Using'} self-hosted GitLab?
                  </Button>

                  {showSelfHosted && (
                    <>
                      <p className="text-muted-foreground mb-2 text-sm">
                        Using a self-hosted GitLab instance is a{' '}
                        <a
                          href="https://kilo.ai/docs/automate/integrations"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline"
                        >
                          feature of Kilo Code Enterprise
                        </a>
                        . Contact{' '}
                        <a href="mailto:sales@kilocode.ai" className="text-primary underline">
                          Sales
                        </a>{' '}
                        to learn more.
                      </p>
                      <div className="space-y-4 rounded-lg border p-4">
                        <div className="space-y-2">
                          <Label htmlFor="instanceUrl">GitLab Instance URL</Label>
                          <div className="relative">
                            <Input
                              id="instanceUrl"
                              type="url"
                              placeholder="https://gitlab.example.com"
                              value={instanceUrl}
                              onChange={e => setInstanceUrl(e.target.value)}
                              className={
                                instanceValidation.status === 'valid'
                                  ? 'border-green-500 pr-10'
                                  : instanceValidation.status === 'invalid'
                                    ? 'border-red-500 pr-10'
                                    : instanceValidation.status === 'validating'
                                      ? 'pr-10'
                                      : ''
                              }
                            />
                            {instanceValidation.status === 'validating' && (
                              <Loader2 className="text-muted-foreground absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin" />
                            )}
                            {instanceValidation.status === 'valid' && (
                              <CheckCircle2 className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-green-500" />
                            )}
                            {instanceValidation.status === 'invalid' && (
                              <AlertCircle className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-red-500" />
                            )}
                          </div>
                        </div>

                        {/* Validation status message */}
                        {instanceValidation.status === 'valid' && instanceValidation.version && (
                          <p className="flex items-center gap-1 text-xs text-green-600">
                            <CheckCircle2 className="h-3 w-3" />
                            GitLab {instanceValidation.version} detected
                            {instanceValidation.enterprise && ' (Enterprise Edition)'}
                          </p>
                        )}
                        {instanceValidation.status === 'valid' && instanceValidation.error && (
                          <p className="text-muted-foreground text-xs">
                            {instanceValidation.error}
                          </p>
                        )}
                        {instanceValidation.status === 'invalid' && instanceValidation.error && (
                          <p className="flex items-center gap-1 text-xs text-red-600">
                            <AlertCircle className="h-3 w-3" />
                            {instanceValidation.error}
                          </p>
                        )}
                        {instanceValidation.status === 'idle' && (
                          <p className="text-muted-foreground text-xs">
                            Enter your self-hosted GitLab instance URL.
                          </p>
                        )}
                        {instanceValidation.status === 'validating' && (
                          <p className="text-muted-foreground text-xs">
                            Validating GitLab instance...
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {connectionMethod === 'oauth' ? (
                  <>
                    {/* OAuth Flow - Client ID/Secret only needed for self-hosted */}
                    {isSelfHostedInput && instanceValidation.status === 'valid' && (
                      <>
                        <Alert>
                          <AlertDescription className="text-sm">
                            For self-hosted GitLab, you need to create an OAuth application on your
                            instance:
                            <ol className="mt-2 list-inside list-decimal space-y-1">
                              <li>
                                Go to <strong>Admin Area → Applications</strong> (or User Settings →
                                Applications)
                              </li>
                              <li>
                                Create a new application with:
                                <ul className="mt-1 ml-4 list-inside list-disc text-xs">
                                  <li>
                                    Redirect URI:{' '}
                                    <code className="bg-muted rounded px-1">
                                      {typeof window !== 'undefined'
                                        ? `${window.location.origin}/api/integrations/gitlab/callback`
                                        : 'https://app.kilo.ai/api/integrations/gitlab/callback'}
                                    </code>
                                  </li>
                                  <li>
                                    Scopes: <code className="bg-muted rounded px-1">api</code>,{' '}
                                    <code className="bg-muted rounded px-1">read_user</code>,{' '}
                                    <code className="bg-muted rounded px-1">read_repository</code>,{' '}
                                    <code className="bg-muted rounded px-1">write_repository</code>
                                  </li>
                                </ul>
                              </li>
                              <li>Copy the Client ID and Secret below</li>
                            </ol>
                          </AlertDescription>
                        </Alert>

                        <div className="space-y-2">
                          <Label htmlFor="clientId">Client ID</Label>
                          <Input
                            id="clientId"
                            type="text"
                            placeholder="Your GitLab Client ID"
                            value={clientId}
                            onChange={e => setClientId(e.target.value)}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="clientSecret">Client Secret</Label>
                          <Input
                            id="clientSecret"
                            type="password"
                            placeholder="Your GitLab Client Secret"
                            value={clientSecret}
                            onChange={e => setClientSecret(e.target.value)}
                          />
                          <p className="text-muted-foreground text-xs">
                            Your credentials are encrypted and stored securely.
                          </p>
                        </div>
                      </>
                    )}

                    <Button
                      onClick={handleConnect}
                      size="lg"
                      className="w-full"
                      disabled={
                        isSelfHostedInput &&
                        (!clientId || !clientSecret || instanceValidation.status !== 'valid')
                      }
                    >
                      <GitBranch className="mr-2 h-4 w-4" />
                      Connect {isSelfHostedInput ? 'Self-Hosted ' : ''}GitLab
                    </Button>
                  </>
                ) : (
                  <>
                    {/* PAT Flow */}
                    <div className="space-y-4">
                      {/* PAT Input */}
                      <div className="space-y-2">
                        <Label htmlFor="patToken">Personal Access Token</Label>
                        <div className="relative">
                          <Input
                            id="patToken"
                            type="password"
                            placeholder="glpat-xxxxxxxxxxxx"
                            value={patToken}
                            onChange={e => setPatToken(e.target.value)}
                            className={
                              patValidation.status === 'valid'
                                ? 'border-green-500 pr-10'
                                : patValidation.status === 'invalid'
                                  ? 'border-red-500 pr-10'
                                  : patValidation.status === 'validating'
                                    ? 'pr-10'
                                    : ''
                            }
                          />
                          {patValidation.status === 'validating' && (
                            <Loader2 className="text-muted-foreground absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin" />
                          )}
                          {patValidation.status === 'valid' && (
                            <CheckCircle2 className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-green-500" />
                          )}
                          {patValidation.status === 'invalid' && (
                            <AlertCircle className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-red-500" />
                          )}
                        </div>
                        <p className="text-muted-foreground text-xs">
                          Create a token at GitLab → User Settings → Access Tokens with{' '}
                          <code className="bg-muted rounded px-1">api</code> scope.
                        </p>
                      </div>

                      {/* Validation Status */}
                      {patValidation.status === 'valid' && patValidation.user && (
                        <div className="rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                            <span className="font-medium text-green-700 dark:text-green-300">
                              Token valid for @{patValidation.user.username}
                            </span>
                          </div>
                          {patValidation.tokenInfo?.expiresAt && (
                            <p className="mt-1 text-xs text-green-600 dark:text-green-400">
                              Expires:{' '}
                              {new Date(patValidation.tokenInfo.expiresAt).toLocaleDateString()}
                            </p>
                          )}
                          {patValidation.warnings?.map((warning, i) => (
                            <p key={i} className="mt-1 text-xs text-amber-600">
                              ⚠️ {warning}
                            </p>
                          ))}
                        </div>
                      )}

                      {patValidation.status === 'invalid' && (
                        <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 text-red-600" />
                            <span className="font-medium text-red-700 dark:text-red-300">
                              {patValidation.error}
                            </span>
                          </div>
                          {patValidation.missingScopes &&
                            patValidation.missingScopes.length > 0 && (
                              <p className="mt-1 text-xs text-red-600">
                                Missing scopes: {patValidation.missingScopes.join(', ')}
                              </p>
                            )}
                        </div>
                      )}

                      <Button
                        onClick={() =>
                          connectWithPATMutate({
                            token: patToken,
                            instanceUrl,
                            organizationId,
                          })
                        }
                        size="lg"
                        className="w-full"
                        disabled={
                          patValidation.status !== 'valid' ||
                          isConnectingWithPAT ||
                          (isSelfHostedInput && instanceValidation.status !== 'valid')
                        }
                      >
                        {isConnectingWithPAT ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Connecting...
                          </>
                        ) : (
                          <>
                            <Key className="mr-2 h-4 w-4" />
                            Connect {isSelfHostedInput ? 'Self-Hosted ' : ''}GitLab with PAT
                          </>
                        )}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
