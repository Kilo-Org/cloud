// Build an RFC 6266 Content-Disposition value for forced downloads, with both
// an ASCII `filename=` fallback and an RFC 5987 `filename*=UTF-8''…` encoded
// form so non-ASCII names survive across browsers. Mirrors the output of the
// jshttp `content-disposition` package; kept inline so the worker doesn't
// take a runtime dep just for this one header.
export function attachmentContentDisposition(filename: string): string {
  const ascii =
    filename
      // eslint-disable-next-line no-control-regex -- strip control chars from header value
      .replace(/[\\"\r\n\x00-\x1f\x7f]/g, '')
      .replace(/[/\\]/g, '_')
      .replace(/[^\x20-\x7e]/g, '?')
      .trim() || 'download';
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
