export function formatBodySizeKilobytes(bytes: number) {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(bytes / 1024)} KB`;
}
