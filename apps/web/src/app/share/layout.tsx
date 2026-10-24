import type { ReactNode } from 'react';
import { publicShareMetadata } from '@/lib/share-page-metadata';

export const metadata = publicShareMetadata;

export default function LegacyShareLayout({ children }: { children: ReactNode }) {
  return children;
}
