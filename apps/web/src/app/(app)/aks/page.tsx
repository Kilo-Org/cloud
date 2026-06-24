import { redirect } from 'next/navigation';

type LegacyAskUsagePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LegacyAskUsagePage({ searchParams }: LegacyAskUsagePageProps) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach(item => query.append(key, item));
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }

  const suffix = query.toString();
  redirect(suffix ? `/ask?${suffix}` : '/ask');
}
