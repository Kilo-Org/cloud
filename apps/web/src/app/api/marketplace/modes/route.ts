import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const GITHUB_RAW_URL =
  'https://raw.githubusercontent.com/Kilo-Org/kilo-marketplace/main/modes/marketplace.yaml';

export const revalidate = 3600; // 1 hour

/**
 * Modes Marketplace API Route
 *
 * Fetches modes.yaml directly from kilo-marketplace GitHub repo.
 * Uses Next.js ISR with 1 hour revalidation for caching.
 */
export async function GET(_request: NextRequest) {
  try {
    const response = await fetch(GITHUB_RAW_URL);

    if (!response.ok) {
      console.error(`Failed to fetch modes from GitHub: ${response.status} ${response.statusText}`);
      return new NextResponse('items: []\n', {
        status: response.status,
        headers: { 'Content-Type': 'application/x-yaml' },
      });
    }

    const yamlContent = await response.text();

    return new NextResponse(yamlContent, {
      headers: {
        'Content-Type': 'application/x-yaml',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (error) {
    console.error('Error fetching modes marketplace data:', error);

    return new NextResponse('items: []\n', {
      status: 500,
      headers: { 'Content-Type': 'application/x-yaml' },
    });
  }
}
