'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Loader2 } from 'lucide-react';
import { ManualSetupSteps } from './ManualSetupSteps';

type JetBrainsRedirectProps = {
  url: string;
  ideName: string;
  logoSrc: string | undefined;
  kiloToken: string;
};

export function OpenIdeAutomatically({ url, ideName, logoSrc, kiloToken }: JetBrainsRedirectProps) {
  const [showManualSetup, setShowManualSetup] = useState(false);

  return (
    <div className="flex flex-col items-center justify-center gap-6 p-8 text-center">
      {!showManualSetup ? (
        <>
          <div className="flex items-center gap-4">
            {logoSrc && (
              <Image
                src={logoSrc}
                alt={`${ideName} Logo`}
                width={48}
                height={48}
                className="h-12 w-12"
              />
            )}
            <h1 className="text-2xl font-bold">Redirecting to {ideName}</h1>
          </div>

          <div className="flex flex-col items-center gap-4">
            <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
            <p className="text-muted-foreground">Opening {ideName} with your authentication...</p>
          </div>

          <p className="text-muted-foreground text-sm">
            If you are not redirected automatically, please{' '}
            <a href={url} className="text-primary font-medium underline-offset-4 hover:underline">
              click here
            </a>
          </p>

          <p className="text-muted-foreground text-sm">
            Trouble opening {ideName}?{' '}
            <button
              onClick={() => setShowManualSetup(true)}
              className="text-primary font-medium underline-offset-4 hover:underline"
            >
              Manual Setup
            </button>
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold">Manual Setup for {ideName}</h1>
          <div className="w-full max-w-2xl space-y-6 text-left">
            <ManualSetupSteps kiloToken={kiloToken} ideDescription={ideName} />
          </div>
          <button
            onClick={() => setShowManualSetup(false)}
            className="text-primary text-sm font-medium underline-offset-4 hover:underline"
          >
            Back to automatic setup
          </button>
        </>
      )}
    </div>
  );
}
