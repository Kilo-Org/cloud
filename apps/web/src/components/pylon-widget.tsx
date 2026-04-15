'use client';

import { useQuery } from '@tanstack/react-query';
import Script from 'next/script';
import { z } from 'zod';
import { useUser } from '@/hooks/useUser';

const pylonIdentitySchema = z.object({
  email: z.string(),
  name: z.string(),
  emailHash: z.string(),
});
type PylonIdentity = z.infer<typeof pylonIdentitySchema>;

async function fetchPylonIdentity(): Promise<PylonIdentity | null> {
  const res = await fetch('/api/pylon/identity');
  if (res.status === 401 || res.status === 403 || res.status === 503) {
    return null;
  }
  if (!res.ok) {
    throw new Error('Failed to fetch Pylon identity');
  }
  return pylonIdentitySchema.parse(await res.json());
}

export function PylonWidget() {
  const appId = process.env.NEXT_PUBLIC_PYLON_APP_ID;
  const { data: user } = useUser();

  // Key by user.id so logout/login in the same tab can't serve a previous
  // user's signed identity payload from cache.
  const { data: identity } = useQuery({
    queryKey: ['pylon-identity', user?.id],
    queryFn: fetchPylonIdentity,
    enabled: Boolean(appId && user?.id),
    staleTime: 5 * 60 * 1000,
  });

  if (!appId || !identity) {
    return null;
  }

  const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
  const safeAppId = encodeURIComponent(appId);
  // Single inline script: assign chat_settings, then run Pylon loader IIFE.
  // Combining guarantees settings are in place before the widget script loads.
  const script = `window.pylon = { chat_settings: { app_id: ${safeJson(appId)}, email: ${safeJson(identity.email)}, name: ${safeJson(identity.name)}, email_hash: ${safeJson(identity.emailHash)} } };(function(){var e=window;var t=document;var n=function(){n.e(arguments)};n.q=[];n.e=function(e){n.q.push(e)};e.Pylon=n;var r=function(){var e=t.createElement("script");e.setAttribute("type","text/javascript");e.setAttribute("async","true");e.setAttribute("src","https://widget.usepylon.com/widget/${safeAppId}");var n=t.getElementsByTagName("script")[0];n.parentNode.insertBefore(e,n)};if(t.readyState==="complete"){r()}else if(e.addEventListener){e.addEventListener("load",r,false)}})();`;

  return (
    <Script id="pylon-chat" strategy="afterInteractive">
      {script}
    </Script>
  );
}
