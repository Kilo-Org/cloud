'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Mail } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation } from '@tanstack/react-query';
import { signIn } from 'next-auth/react';
import { type AuthProviderId, LinkableAuthProviders } from '@/lib/auth/provider-metadata';

export type AuthProvider = {
  provider: AuthProviderId;
  email: string;
  avatar_url: string;
  hosted_domain: string | null;
  created_at: string;
};

type LoginMethodsCardProps = {
  primaryEmail: string;
  providers: AuthProvider[];
  onError: (error: string) => void;
};

export function LoginMethodsCard({ primaryEmail, providers, onError }: LoginMethodsCardProps) {
  const trpc = useTRPC();
  const alreadyLinkedProviders = new Set(providers.map(o => o.provider));
  const availableProviders = LinkableAuthProviders.filter(p => !alreadyLinkedProviders.has(p.id));

  const linkMutation = useMutation(
    trpc.user.linkAuthProvider.mutationOptions({
      onSuccess: (data, variables) => {
        void signIn(variables.provider, {
          callbackUrl: `/connected-accounts?linked=${variables.provider}`,
        });
      },
      onError: () => onError('LINKING-FAILED'),
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

        {availableProviders.length > 0 && (
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
        )}
      </CardContent>
    </Card>
  );
}
