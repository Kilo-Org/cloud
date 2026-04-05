import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Shield, ArrowRight, Loader2, CheckCircle } from 'lucide-react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { usePostHog } from 'posthog-js/react';
import type {
  OrganizationRole,
  OrganizationWithMembers,
} from '@/lib/organizations/organization-types';

type SSOSignupCardProps = {
  organization: OrganizationWithMembers;
  role: OrganizationRole;
};

// SSO Hooks following the same pattern as hooks.ts
function useOrganizationSSOConfig(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.organizations.sso.getConfig.queryOptions({ organizationId }));
}

function useGenerateAdminPortalLink() {
  const trpc = useTRPC();

  return useMutation(
    trpc.organizations.sso.generateAdminPortalLink.mutationOptions({
      onSuccess: data => {
        window.open(data.link, '_blank', 'noopener,noreferrer');
      },
      onError: error => {
        toast.error(error.message || 'Failed to generate admin portal link');
      },
    })
  );
}

export function SSOSignupCard({ organization, role }: SSOSignupCardProps) {
  const organizationId = organization.id;
  const { data: ssoConfig, isLoading, error } = useOrganizationSSOConfig(organizationId);
  const generatePortalLink = useGenerateAdminPortalLink();
  const posthog = usePostHog();

  const handleSetupSSO = () => {
    posthog?.capture('sso_setup_initiated', { organizationId });
    window.open('https://kilo.ai/setup-sso', '_blank');
  };

  const handleDomainVerification = () => {
    generatePortalLink.mutate({ organizationId, linkType: 'domain-verification' });
  };

  const handleSSOConfiguration = () => {
    generatePortalLink.mutate({ organizationId, linkType: 'sso' });
    posthog?.capture('sso_setup_initiated', { organizationId });
  };

  // Don't show card if loading or error
  if (isLoading || error) {
    return null;
  }

  // Show existing config if it exists (ssoConfig will be false if no config exists)
  if (ssoConfig && typeof ssoConfig === 'object') {
    const isDomainVerified = ssoConfig.isDomainVerified;
    const hasConnection = ssoConfig.hasConnection;
    // Extract domain from the domains array
    const domain = ssoConfig.domains?.[0]?.domain || organization.sso_domain || 'your domain';

    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <Shield className="mr-2 inline h-5 w-5" />
            Single Sign-On (SSO) Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Show different copy based on SSO configuration status */}
            {isDomainVerified && hasConnection ? (
              <p className="text-muted-foreground text-sm">
                SSO is configured for this organization. New users can still be invited via the Kilo
                Code dashboard, but emails matching your verified domain must login through SSO.
                Contact support if you need to disable SSO.
              </p>
            ) : (
              <>
                <p className="text-muted-foreground text-sm">
                  Configure your organization's Single Sign-On settings.
                </p>

                {/* Status Indicators - only show when SSO is not fully configured */}
                <div className="space-y-2">
                  {/* Domain Verification Status */}
                  <div className="bg-muted/50 flex items-center justify-between gap-2 rounded-md p-3">
                    <div className="flex items-center gap-2">
                      {isDomainVerified ? (
                        <>
                          <CheckCircle className="h-5 w-5 text-green-600" />
                          <span className="text-muted-foreground text-sm">
                            <code className="bg-muted text-muted-foreground rounded px-1 text-xs">
                              {domain}
                            </code>{' '}
                            Domain Verified
                          </span>
                        </>
                      ) : (
                        <>
                          <div className="border-muted-foreground/30 h-5 w-5 rounded-full border-2" />
                          <span className="text-muted-foreground text-sm">
                            <code className="bg-muted text-muted-foreground rounded px-1 text-xs">
                              {domain}
                            </code>{' '}
                            Domain Verification Pending
                          </span>
                        </>
                      )}
                    </div>
                    {/* Verify Domain Link - only show to owners when domain is not verified */}
                    {!isDomainVerified && role === 'owner' && (
                      <button
                        onClick={handleDomainVerification}
                        disabled={generatePortalLink.isPending}
                        className="cursor-pointer text-sm text-yellow-400 underline hover:text-yellow-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {generatePortalLink.isPending ? 'Opening...' : 'Verify'}
                      </button>
                    )}
                  </div>

                  {/* SSO Configuration Status/Button */}
                  {hasConnection ? (
                    <button
                      onClick={handleSSOConfiguration}
                      disabled={generatePortalLink.isPending}
                      className="bg-muted/50 hover:bg-muted/70 flex w-full cursor-pointer items-center gap-2 rounded-md p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {generatePortalLink.isPending ? (
                        <Loader2 className="h-5 w-5 animate-spin text-green-600" />
                      ) : (
                        <CheckCircle className="h-5 w-5 text-green-600" />
                      )}
                      <span className="text-muted-foreground text-sm">
                        {generatePortalLink.isPending ? 'Opening...' : 'SSO Configured'}
                      </span>
                    </button>
                  ) : (
                    <div className="bg-muted/50 flex items-center justify-between gap-2 rounded-md p-3">
                      <div className="flex items-center gap-2">
                        <div className="border-muted-foreground/30 h-5 w-5 rounded-full border-2" />
                        <span className="text-muted-foreground text-sm">
                          SSO Configuration Pending
                        </span>
                      </div>
                      {/* Complete Setup Link - only show to owners when domain is verified */}
                      {isDomainVerified && role === 'owner' && (
                        <button
                          onClick={handleSSOConfiguration}
                          disabled={generatePortalLink.isPending}
                          className="cursor-pointer text-sm text-yellow-400 underline hover:text-yellow-300 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {generatePortalLink.isPending ? 'Opening...' : 'Complete setup'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show setup button if config doesn't exist (getConfig returns false)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Shield className="mr-2 inline h-5 w-5" />
          Single Sign-On (SSO)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Enhance your organization's security and streamline access with Single Sign-On. Connect
            your existing identity provider to manage user authentication centrally.
          </p>
          <div className="flex flex-col space-y-2">
            <div className="text-muted-foreground flex items-center text-sm">
              <ArrowRight className="mr-2 h-4 w-4" />
              Centralized user management
            </div>
            <div className="text-muted-foreground flex items-center text-sm">
              <ArrowRight className="mr-2 h-4 w-4" />
              Enhanced security with your identity provider
            </div>
            <div className="text-muted-foreground flex items-center text-sm">
              <ArrowRight className="mr-2 h-4 w-4" />
              Seamless user onboarding
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="w-full">
                <Button onClick={handleSetupSSO} disabled={role !== 'owner'} className="w-full">
                  Set up SSO
                </Button>
              </span>
            </TooltipTrigger>
            {role !== 'owner' && (
              <TooltipContent>
                <p>Contact your organization administrator to set up SSO</p>
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </CardContent>
    </Card>
  );
}
