export function cleanUrl(url: string): { url: string; trailing: string } {
  let trailing = '';

  while (url.length > 0 && /[.,;:!?]$/.test(url)) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }

  while (url.endsWith(')')) {
    const opens = (url.match(/\(/g) || []).length;
    const closes = (url.match(/\)/g) || []).length;
    if (closes <= opens) break;
    trailing = ')' + trailing;
    url = url.slice(0, -1);
  }

  return { url, trailing };
}
