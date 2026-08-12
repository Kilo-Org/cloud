import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

const USAGE_STATUS_INCIDENT_URL = 'https://status.kilo.ai/incidents/5djn5qjqlp1q';

export function UsageAvailabilityBanner() {
  return (
    <Alert variant="warning">
      <TriangleAlert className="size-4" />
      <AlertDescription>
        <span>
          Usage currently has reduced availability.{' '}
          <a
            href={USAGE_STATUS_INCIDENT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:opacity-80"
          >
            Check the status page
          </a>{' '}
          for updates.
        </span>
      </AlertDescription>
    </Alert>
  );
}
