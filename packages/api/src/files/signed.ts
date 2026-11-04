import crypto from 'node:crypto';
import {
  MAX_DOWNLOAD_URL_EXPIRY_SECONDS,
  DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS,
} from 'librechat-data-provider';
import type { DownloadURLParams, DownloadURLResult } from '~/storage/types';

/** Where the signed download proxy is mounted, relative to the server's public URL. */
export const SIGNED_DOWNLOAD_PATH = '/api/files/signed';

/**
 * HKDF `info` for the signing key. Deriving a dedicated key keeps download signatures from ever
 * being computed with the raw secret the caller also uses for other purposes (session JWTs).
 */
const SIGNING_KEY_INFO = 'librechat:file-download:v1';
/** A signed URL grants a read and nothing else. */
const SIGNED_METHOD = 'GET';
/** The file record's `_id`: server-generated and unique, unlike a client-supplied `file_id`. */
const ID_PATTERN = /^[a-f0-9]{24}$/;
const EXPIRES_PATTERN = /^\d{1,12}$/;
/** Base64url HMAC-SHA256, unpadded. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type SignedDownloadErrorCode = 'invalid_url' | 'expired_url';

export type SignedDownloadVerification =
  | { ok: true; value: { id: string } }
  | { ok: false; error: { code: SignedDownloadErrorCode } };

export interface SignedDownloadURLParams extends DownloadURLParams {
  secret: string | undefined;
  /** Public URL of this server (`DOMAIN_SERVER`); may carry a path prefix. */
  baseURL: string | undefined;
  now?: number;
}

export interface SignedDownloadInput {
  secret: string;
  /** The request method; HEAD is checked as GET, since it reads the same resource. */
  method: string;
  /** Raw request values: anything other than a well-formed string is rejected. */
  id: unknown;
  expires: unknown;
  signature: unknown;
  now?: number;
}

function sign(secret: string, method: string, id: string, expires: string): string {
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, '', SIGNING_KEY_INFO, 32));
  return crypto
    .createHmac('sha256', key)
    .update(`${method}\n${id}\n${expires}`)
    .digest('base64url');
}

const invalid = (code: SignedDownloadErrorCode): SignedDownloadVerification => ({
  ok: false,
  error: { code },
});

/**
 * Checks a signed download URL. The signature covers the method, the record id and the expiry,
 * and is verified in constant time before the expiry is read, so `expired_url` is only reported
 * for a URL this server issued; a forged or altered one is always `invalid_url`. An expiry
 * further out than the lifetime cap is rejected even when correctly signed.
 */
export function verifySignedDownload({
  secret,
  method,
  id,
  expires,
  signature,
  now = Date.now(),
}: SignedDownloadInput): SignedDownloadVerification {
  if (
    typeof id !== 'string' ||
    typeof expires !== 'string' ||
    typeof signature !== 'string' ||
    !ID_PATTERN.test(id) ||
    !EXPIRES_PATTERN.test(expires) ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    return invalid('invalid_url');
  }

  const signedMethod = method === 'HEAD' ? SIGNED_METHOD : method;
  const expected = Buffer.from(sign(secret, signedMethod, id, expires));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return invalid('invalid_url');
  }

  const expiresAt = Number(expires);
  const nowSeconds = Math.floor(now / 1000);
  if (expiresAt - nowSeconds > MAX_DOWNLOAD_URL_EXPIRY_SECONDS) {
    return invalid('invalid_url');
  }
  if (nowSeconds >= expiresAt) {
    return invalid('expired_url');
  }
  return { ok: true, value: { id } };
}

/**
 * Signs a download URL for storage without native signed URLs. The URL points at the LibreChat
 * download proxy and carries an HMAC over the method, the file record id and the expiry, so it
 * grants a read of that one record until it expires without a session or storage credentials.
 * It names the record, never a filesystem path.
 */
export async function getSignedDownloadURL({
  file,
  secret,
  baseURL,
  expiresIn = DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS,
  now = Date.now(),
}: SignedDownloadURLParams): Promise<DownloadURLResult> {
  if (!secret) {
    throw new Error('[getSignedDownloadURL] A signing secret is required');
  }
  if (!baseURL) {
    throw new Error('[getSignedDownloadURL] A public server URL is required');
  }
  const id = file._id?.toString();
  if (!id || !ID_PATTERN.test(id)) {
    throw new Error('[getSignedDownloadURL] File record has no valid id');
  }
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new Error('[getSignedDownloadURL] Expiry must be a positive whole number of seconds');
  }

  const expiresAtSeconds =
    Math.floor(now / 1000) + Math.min(expiresIn, MAX_DOWNLOAD_URL_EXPIRY_SECONDS);
  const expires = String(expiresAtSeconds);
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  const url = new URL(`${SIGNED_DOWNLOAD_PATH.slice(1)}/${id}`, base);
  url.searchParams.set('expires', expires);
  url.searchParams.set('signature', sign(secret, SIGNED_METHOD, id, expires));
  return { url: url.toString(), expiresAt: new Date(expiresAtSeconds * 1000) };
}
