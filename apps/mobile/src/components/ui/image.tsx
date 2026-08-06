import { Image as ExpoImage, type ImageProps } from 'expo-image';
import { styled } from 'nativewind';

const StyledImage = styled(ExpoImage, { className: 'style' });

/**
 * Shared image primitive. `alt` is optional (D4): when a caller sets it, the
 * image is exposed to assistive technologies as a labeled image; when absent
 * the image stays decorative — expo-image's `accessible` default of `false`
 * preserves the previous behavior for every existing caller.
 */
export function Image({ alt, ...props }: ImageProps) {
  if (alt) {
    return <StyledImage {...props} accessible accessibilityRole="image" accessibilityLabel={alt} />;
  }
  return <StyledImage {...props} />;
}
