import { NextResponse } from 'next/server';

export async function GET(): Promise<
  NextResponse<{ '/.well-known/appspecific/com.chrome.devtools.json': { resources: never[] } }>
> {
  return NextResponse.json({
    '/.well-known/appspecific/com.chrome.devtools.json': {
      resources: [],
    },
  });
}
