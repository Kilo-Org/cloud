export const sanitizeTabContextText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const sanitizeTabContextUrl = (url: string): string => {
  try {
    const parsedUrl = new URL(url);

    parsedUrl.search = '';
    parsedUrl.hash = '';

    return parsedUrl.toString();
  } catch {
    return '[invalid URL]';
  }
};
