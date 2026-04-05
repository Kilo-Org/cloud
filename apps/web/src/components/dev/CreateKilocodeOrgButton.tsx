'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CreateKilocodeOrgButton() {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  // Only show in development mode
  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  const handleCreateOrg = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/dev/create-kilocode-org', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create organization');
      }

      const data = await response.json();
      console.log('Successfully created/linked Kilocode dev organization:', data);

      // Navigate to the organization page
      router.push(`/organizations/${data.organizationId}`);
    } catch (error) {
      console.error('Error creating organization:', error);
      alert(
        error instanceof Error ? error.message : 'Failed to create organization. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative">
      {/* Goofy brown tilted banner */}
      <div
        className="absolute -top-4 -left-2 z-10"
        style={{
          filter: 'drop-shadow(0 3px 6px rgba(0, 0, 0, 0.5))',
          transform: 'translateZ(0)',
        }}
      >
        <h3
          className="-rotate-[8deg] bg-amber-900 px-2 text-lg font-bold text-amber-200"
          style={{
            fontFamily: "'Marker Felt', 'Comic Sans MS', 'cursive'",
            clipPath: 'polygon(0% 2%,20% 0%, 55% 7%,65% 0%,70% 4%, 98% 0, 100% 97%, 2% 100%)',
          }}
        >
          <span className="text-2xl">🔧</span> DEV
        </h3>
      </div>
      <button
        onClick={handleCreateOrg}
        disabled={isLoading}
        className="relative inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-md border border-blue-700 bg-blue-950 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:border-blue-600 hover:bg-blue-900 hover:shadow-md focus-visible:ring-1 focus-visible:ring-blue-400 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        style={{
          backgroundImage:
            'repeating-linear-gradient(-45deg, transparent, transparent 5px, rgba(191, 219, 254, 0.4) 5px, rgba(191, 219, 254, 0.4) 10px)',
          fontFamily: "'Comic Sans MS', 'Marker Felt', cursive",
        }}
      >
        {isLoading ? 'Creating...' : 'Force Create and Join Kilocode Org'}
      </button>
    </div>
  );
}
