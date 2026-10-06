export default {
  fetch() {
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<CloudflareEnv>;
