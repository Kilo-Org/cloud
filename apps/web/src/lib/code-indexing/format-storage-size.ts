export function formatStorageSize(kb: number): string {
  if (kb >= 1024 * 1024) {
    return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
  } else if (kb >= 1024) {
    return `${(kb / 1024).toFixed(2)} MB`;
  } else {
    return `${kb.toFixed(2)} KB`;
  }
}
