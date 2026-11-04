export type DispositionType = 'attachment' | 'inline';

/** A lone UTF-16 surrogate, which `encodeURIComponent` cannot encode. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const encodeRFC5987ValueChars = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function getAsciiFilenameFallback(filename: string): string {
  const fallback = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return fallback || 'download';
}

/**
 * Builds an RFC 6266 `Content-Disposition` value: a quoted ASCII `filename` for old clients and
 * an RFC 5987 `filename*` carrying the exact UTF-8 name. The result is pure printable ASCII, so
 * it is safe both as a response header and as a signed storage override such as S3's
 * `response-content-disposition`. An empty name falls back to `download`, so the disposition
 * type is always present.
 */
export function formatContentDisposition(
  filename: string | null | undefined,
  type: DispositionType = 'attachment',
): string {
  const name = (filename || 'download').replace(LONE_SURROGATE, '\uFFFD');
  const fallback = getAsciiFilenameFallback(name);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(name)}`;
}
