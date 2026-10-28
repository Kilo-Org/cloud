export function previewUpstreamUrl(pathname: string, search: string, port: number): string {
  return `http://localhost:${port}${pathname}${search}`;
}

export function previewUpstreamHost(port: number): string {
  return `localhost:${port}`;
}
