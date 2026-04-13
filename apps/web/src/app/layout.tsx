import type { Metadata, Viewport } from 'next';
import { Inter, Roboto_Mono, JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import './globals.css';
import { PostHogProvider } from '../components/PostHogProvider';
import { Providers } from '../components/Providers';
import { DataLayerProvider } from '../components/DataLayerProvider';
import { headers } from 'next/headers';
import { APP_URL } from '@/lib/constants';
import { CSP_NONCE_HEADER } from '@/lib/security-headers';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const mono = Roboto_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains',
});

export const metadata: Metadata = {
  title: 'Kilo Code - Open source AI agent VS Code extension',
  description:
    'Write code more efficiently by generating code, automating tasks, and providing suggestions',
  metadataBase: new URL(APP_URL),
  openGraph: {
    type: 'website',
    url: APP_URL,
    title: 'Kilo Code - Open source AI agent VS Code extension',
    description:
      'Write code more efficiently by generating code, automating tasks, and providing suggestions',
    siteName: 'Kilo Code',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kilo Code - Open source AI agent VS Code extension',
    description:
      'Write code more efficiently by generating code, automating tasks, and providing suggestions',
  },
  icons: {
    icon:
      process.env.NODE_ENV !== 'production'
        ? [{ url: '/kilo-v1-DEV.svg', type: 'image/svg+xml' }]
        : [
            { url: '/favicon.ico', sizes: '48x48', type: 'image/x-icon' },
            { url: '/favicon/favicon.svg', type: 'image/svg+xml' },
          ],
    apple: {
      url: '/favicon/apple-touch-icon.png',
      sizes: '180x180',
      type: 'image/png',
    },
    shortcut: { url: '/favicon.ico' },
    other: [
      {
        rel: 'manifest',
        url: '/site.webmanifest',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '192x192',
        url: '/favicon/android-chrome-192x192.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '512x512',
        url: '/favicon/android-chrome-512x512.png',
      },
    ],
  },
  other: {
    _foundr: 'e63f9874cd5c7caaf51e42c7309aee22',
  },
};

export const viewport: Viewport = {
  themeColor: '#617A91',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Root layout component
 * This is a server component that wraps the entire application
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <html
      suppressHydrationWarning
      lang="en"
      className={`${inter.variable} ${mono.variable} ${jetbrainsMono.variable} antialiased`}
    >
      <head />
      <body>
        <Providers>
          <DataLayerProvider />
          <PostHogProvider>{children}</PostHogProvider>
        </Providers>

        {process.env.NEXT_PUBLIC_GTM_ID && (
          <Script id="google-tag-manager" nonce={nonce} strategy="afterInteractive">
            {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${process.env.NEXT_PUBLIC_GTM_ID}');`}
          </Script>
        )}

        {process.env.NEXT_PUBLIC_IMPACT_UTT_ID && (
          <Script id="impact-utt" nonce={nonce} strategy="beforeInteractive">
            {`(function(a,b,c,d,e,f,g){e.ire_o=c;e[c]=e[c]||function(){(e[c].a=e[c].a||[]).push(arguments)};f=d.createElement(b);g=d.getElementsByTagName(b)[0];f.async=1;f.src=a;g.parentNode.insertBefore(f,g);})('https://utt.impactcdn.com/${process.env.NEXT_PUBLIC_IMPACT_UTT_ID}.js','script','ire',document,window);`}
          </Script>
        )}
      </body>
    </html>
  );
}
