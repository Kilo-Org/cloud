'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Mail } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation } from '@tanstack/react-query';
import { signIn } from 'next-auth/react';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { AccountLinkingProviders } from '@/lib/auth/provider-metadata';
import { useClaudeSignInConfigured } from '@/lib/auth/claude/use-claude-sign-in-configured';
import { signInMethodChangeError } from '@/lib/auth/sign-in-method-change-codes';

export type AuthProvider = {
  provider: AuthProviderId;
  email: string;
  avatar_url: string;
  hosted_domain: string | null;
  created_at: string;
};

type LoginMethodsCardProps = {
  /**
   * Where the provider round trip returns. The app shell passes its own page so
   * the link completes inside the shell instead of the full web page.
   */
  callbackPath?: string;
  primaryEmail: string;
  providers: AuthProvider[];
  onError: (error: string) => void;
  /**
   * Lists the methods without the link actions. The app shell sets it: its
   * session is not a browser sign-in, so the server refuses a link from it.
   */
  readOnly?: boolean;
};

export function LoginMethodsCard({
  primaryEmail,
  providers,
  onError,
  callbackPath = '/connected-accounts',
  readOnly = false,
}: LoginMethodsCardProps) {
  const trpc = useTRPC();
  const alreadyLinkedProviders = new Set(providers.map(o => o.provider));
  const claudeConfigured = useClaudeSignInConfigured();
  const availableProviders = AccountLinkingProviders.filter(
    p => !alreadyLinkedProviders.has(p.id) && (p.id !== 'claude' || claudeConfigured)
  );

  const linkMutation = useMutation(
    trpc.user.linkAuthProvider.mutationOptions({
      onSuccess: (data, variables) => {
        void signIn(variables.provider, {
          callbackUrl: `${callbackPath}?linked=${variables.provider}`,
        });
      },
      onError: error => onError(signInMethodChangeError(error) ?? 'LINKING-FAILED'),
    })
  );

  return (
    <Card className="h-full w-full rounded-xl shadow-sm">
      <CardContent className="space-y-6 pt-6">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            <span className="font-medium">Primary Email</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <span className="text-sm">{primaryEmail}</span>
            <Badge variant="secondary">Primary</Badge>
          </div>
        </div>

        {readOnly ? (
          <p className="text-muted-foreground text-sm">
            To add or remove a sign-in method, sign in to app.kilo.ai in a web browser.
          </p>
        ) : (
          availableProviders.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                <span className="font-medium">Link New Account</span>
              </div>
              <div className="space-y-2">
                {availableProviders.map(provider => (
                  <Button
                    key={provider.id}
                    variant="outline"
                    onClick={() => linkMutation.mutate({ provider: provider.id })}
                    className="w-full justify-start"
                  >
                    <span className="mr-2">{provider.icon}</span>
                    Link {provider.name} Account
                  </Button>
                ))}
              </div>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
