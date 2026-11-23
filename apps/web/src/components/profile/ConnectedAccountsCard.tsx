'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Link as LinkIcon, Unlink } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AuthProvider } from './LoginMethodsCard';
import { UnlinkAccountDialog } from './UnlinkAccountDialog';
import { SignInMethodCodeDialog } from './SignInMethodCodeDialog';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { getProviderById } from '@/lib/auth/provider-metadata';

type ConnectedAccountsCardProps = {
  providers: AuthProvider[];
  onRefetch: () => Promise<unknown>;
  onError: (error: string) => void;
  /** Lists the accounts without the unlink action; see `LoginMethodsCard`. */
  readOnly?: boolean;
};

export function ConnectedAccountsCard({
  providers,
  onRefetch,
  onError,
  readOnly = false,
}: ConnectedAccountsCardProps) {
  const [unlinkingProvider, setUnlinkingProvider] = useState<AuthProviderId | null>(null);
  const [showConfirmUnlink, setShowConfirmUnlink] = useState<AuthProviderId | null>(null);
  const [codeProvider, setCodeProvider] = useState<AuthProviderId | null>(null);
  const trpc = useTRPC();

  const unlinkMutation = useMutation(
    trpc.user.unlinkAuthProvider.mutationOptions({
      onSuccess: async (_data, variables) => {
        const providerName = getProviderById(variables.provider).name;
        toast.success(`${providerName} account unlinked successfully`);
        await onRefetch();
        setUnlinkingProvider(null);
        setShowConfirmUnlink(null);
        setCodeProvider(null);
      },
    })
  );

  return (
    <div className="space-y-4">
      <UnlinkAccountDialog
        open={!!showConfirmUnlink}
        providerName={showConfirmUnlink ? getProviderById(showConfirmUnlink).name : ''}
        onConfirm={() => {
          if (!showConfirmUnlink) return;
          // The code step confirms the unlink, so the confirmation closes now.
          setCodeProvider(showConfirmUnlink);
          setShowConfirmUnlink(null);
        }}
        onCancel={() => setShowConfirmUnlink(null)}
      />

      {codeProvider !== null && (
        <SignInMethodCodeDialog
          open
          change="unlink"
          provider={codeProvider}
          onOpenChange={open => {
            if (!open) setCodeProvider(null);
          }}
          onError={onError}
          onVerified={async (code, challengeId) => {
            if (codeProvider === null) return;
            setUnlinkingProvider(codeProvider);
            try {
              await unlinkMutation.mutateAsync({ provider: codeProvider, code, challengeId });
            } finally {
              setUnlinkingProvider(null);
            }
          }}
        />
      )}

      <Card className="h-full w-full rounded-xl shadow-sm">
        <CardContent className="space-y-6 pt-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4" />
              <span className="font-medium">Connected Accounts</span>
            </div>
            <div className="space-y-2">
              {providers.map((provider: AuthProvider) => (
                <div
                  key={provider.provider}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{getProviderById(provider.provider).icon}</span>
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={provider.avatar_url} alt={provider.email} />
                      <AvatarFallback className="text-xs">
                        {provider.email.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">{getProviderById(provider.provider).name}</div>
                      <div className="text-muted-foreground text-sm">{provider.email}</div>
                    </div>
                  </div>
                  {!readOnly && providers.length > 1 && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={unlinkingProvider === provider.provider}
                      onClick={() => setShowConfirmUnlink(provider.provider)}
                    >
                      <Unlink className="mr-1 h-4 w-4" />
                      Unlink
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
