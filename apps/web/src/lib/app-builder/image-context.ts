import type { Images } from '@/lib/images-schema';

type ImageInfo = {
  filename: string;
  path: string;
};

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildImageContext(images: ImageInfo[]): string {
  if (images.length === 0) return '';

  const imageElements = images
    .map(
      img =>
        `  <image filename="${escapeXmlAttr(img.filename)}" sourcePath="${escapeXmlAttr(img.path)}" />`
    )
    .join('\n');

  return '\n\n<available_images>\n' + imageElements + '\n</available_images>';
}

function buildImageContextFromAttachments(images: Images | undefined): string {
  if (!images) return '';
  return buildImageContext(
    images.files.map(filename => ({
      filename,
      path: `${images.path}/${filename}`,
    }))
  );
}

export { buildImageContext, buildImageContextFromAttachments };
