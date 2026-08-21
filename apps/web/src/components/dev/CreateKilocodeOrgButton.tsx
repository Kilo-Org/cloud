'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

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
      toast.error(
        error instanceof Error ? error.message : 'Failed to create organization. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="secondary"
      onClick={handleCreateOrg}
      disabled={isLoading}
      className="w-full"
    >
      {isLoading ? 'Creating...' : 'Create dev organization'}
    </Button>
  );
}