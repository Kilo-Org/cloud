import React from 'react';

export function ProviderAttribution({
  providerDisplayName,
  routingProviderDisplayName,
}: {
  providerDisplayName: string;
  routingProviderDisplayName: string;
}) {
  return (
    <div>
      <div>{providerDisplayName}</div>
      {providerDisplayName !== routingProviderDisplayName ? (
        <div className="text-muted-foreground mt-0.5 text-xs font-normal">
          via {routingProviderDisplayName}
        </div>
      ) : null}
    </div>
  );
}
