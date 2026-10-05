export function getAiGatewayRewrites(env = process.env) {
  const origin =
    env.NODE_ENV === 'development'
      ? `http://localhost:${env.AI_GATEWAY_PORT || 3010 + Number(env.KILO_PORT_OFFSET || 0)}`
      : env.VERCEL_ENV === 'production'
        ? 'https://ai-gateway.kilo.ai'
        : undefined;

  if (!origin) return [];

  return [
    {
      source: '/api/gateway/typesafe/v1/systemone',
      destination: `${origin}/api/v1/systemone`,
    },
    ...['gateway', 'openrouter'].flatMap(prefix => [
      {
        source: `/api/${prefix}/v1/:path*`,
        destination: `${origin}/api/v1/:path*`,
      },
      {
        source: `/api/${prefix}/:path*`,
        destination: `${origin}/api/v1/:path*`,
      },
    ]),
    {
      source: '/api/fim/completions',
      destination: `${origin}/api/v1/fim/completions`,
    },
    {
      source: '/api/edit/completions',
      destination: `${origin}/api/v1/edit/completions`,
    },
    {
      source: '/api/organizations/:id/models',
      destination: `${origin}/api/v1/organizations/:id/models`,
    },
    {
      source: '/api/organizations/:id/models/validate',
      destination: `${origin}/api/v1/organizations/:id/models/validate`,
    },
  ];
}
