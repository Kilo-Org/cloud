import { Code2 } from 'lucide-react';
import { BytePlusPlanIcon } from './BytePlusPlanIcon';
import { MiniMaxPlanIcon } from './MiniMaxPlanIcon';

// Resolves a Coding Plan provider ID to its icon. Unknown future providers
// keep the generic Code2 fallback.
export function CodingPlanProviderIcon({ providerId }: { providerId: string }) {
  switch (providerId) {
    case 'minimax':
      return <MiniMaxPlanIcon />;
    case 'byteplus-coding':
      return <BytePlusPlanIcon />;
    default:
      return <Code2 className="size-5" />;
  }
}
