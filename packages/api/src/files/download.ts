import {
  FileSources,
  checkOpenAIStorage,
  MAX_DOWNLOAD_URL_EXPIRY_SECONDS,
  DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS,
} from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { DownloadURLParams, DownloadURLResult } from '~/storage/types';
import type { ServerRequest } from '~/types/http';

export type FileDownloadURLErrorCode = 'unsupported_source' | 'missing_model';

export type FileDownloadURLOutcome =
  | { ok: true; value: DownloadURLResult }
  | { ok: false; error: { code: FileDownloadURLErrorCode } };

export type FileDownloadURLStrategy = {
  getDownloadURL?: (params: DownloadURLParams) => Promise<DownloadURLResult>;
};

export type FileDownloadURLRequest = {
  /** Already-authorized file record; this function performs no access checks. */
  file: TFile & { model?: string };
  filename: string;
  req?: ServerRequest;
  /** Lifetime in seconds, capped at the ceiling. Unset keeps the strategy's own default. */
  expiresIn?: number;
  getStrategyFunctions: (source: string) => FileDownloadURLStrategy;
};

/** Sources whose download URL points at the storage provider, not back at this server. */
const DIRECT_DOWNLOAD_SOURCES = new Set<string>([FileSources.s3, FileSources.cloudfront]);

export function isDirectDownloadSource(source: string | null | undefined): boolean {
  return source != null && DIRECT_DOWNLOAD_SOURCES.has(source);
}

/** Clamps to the lifetime ceiling even though the config schema does too, so no caller can exceed it. */
export function resolveDownloadURLExpiry(expiresIn: number | undefined): number {
  if (expiresIn === undefined || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    return DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS;
  }
  return Math.min(expiresIn, MAX_DOWNLOAD_URL_EXPIRY_SECONDS);
}

/**
 * A source's signer, or `undefined` when its bytes cannot be reached through a signed URL. Text
 * files resolve to the local strategy but their content lives in the database, and an
 * unrecognized legacy source makes the strategy lookup throw; both count as unsupported.
 */
function getSigner(
  source: string,
  getStrategyFunctions: FileDownloadURLRequest['getStrategyFunctions'],
): FileDownloadURLStrategy['getDownloadURL'] {
  if (checkOpenAIStorage(source) || source === FileSources.text) {
    return undefined;
  }
  try {
    return getStrategyFunctions(source).getDownloadURL;
  } catch {
    return undefined;
  }
}

/** Whether a source's bytes can be reached through a signed URL, without signing one. */
export function supportsDownloadURL(
  source: string,
  getStrategyFunctions: FileDownloadURLRequest['getStrategyFunctions'],
): boolean {
  return getSigner(source, getStrategyFunctions) != null;
}

/**
 * Signs a short-lived, read-only URL through the file's storage strategy.
 * Sources without `getDownloadURL` resolve to `unsupported_source`; signing failures throw.
 */
export async function resolveFileDownloadURL({
  req,
  file,
  filename,
  expiresIn,
  getStrategyFunctions,
}: FileDownloadURLRequest): Promise<FileDownloadURLOutcome> {
  const source = file.source ?? FileSources.local;
  if (checkOpenAIStorage(source)) {
    return { ok: false, error: { code: file.model ? 'unsupported_source' : 'missing_model' } };
  }
  const getDownloadURL = getSigner(source, getStrategyFunctions);
  if (!getDownloadURL) {
    return { ok: false, error: { code: 'unsupported_source' } };
  }

  const value = await getDownloadURL({
    req,
    file,
    customFilename: filename,
    contentType: file.type || 'application/octet-stream',
    /** Unset leaves S3 on `S3_URL_EXPIRY_SECONDS` and CloudFront on `cloudfront.urlExpiry`. */
    expiresIn: expiresIn === undefined ? undefined : resolveDownloadURLExpiry(expiresIn),
  });
  return { ok: true, value };
}
