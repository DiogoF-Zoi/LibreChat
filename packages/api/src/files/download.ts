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
  expiresIn?: number;
  getStrategyFunctions: (source: string) => FileDownloadURLStrategy;
};

/**
 * Sources whose download URL points straight at the storage provider. A redirect to one moves
 * the transfer off this server; any other source's URL would point back at this server.
 */
const DIRECT_DOWNLOAD_SOURCES = new Set<string>([FileSources.s3, FileSources.cloudfront]);

export function isDirectDownloadSource(source: string | null | undefined): boolean {
  return source != null && DIRECT_DOWNLOAD_SOURCES.has(source);
}

/**
 * Bounds a requested lifetime to whole seconds within the ceiling. The config schema already
 * enforces this; it is repeated here so no caller or strategy can sign a longer-lived URL.
 */
export function resolveDownloadURLExpiry(expiresIn: number | undefined): number {
  if (expiresIn === undefined || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    return DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS;
  }
  return Math.min(expiresIn, MAX_DOWNLOAD_URL_EXPIRY_SECONDS);
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
  /** Text files resolve to the local strategy but keep their content in the database, not on disk. */
  if (source === FileSources.text) {
    return { ok: false, error: { code: 'unsupported_source' } };
  }

  const { getDownloadURL } = getStrategyFunctions(source);
  if (!getDownloadURL) {
    return { ok: false, error: { code: 'unsupported_source' } };
  }

  const value = await getDownloadURL({
    req,
    file,
    customFilename: filename,
    contentType: file.type || 'application/octet-stream',
    expiresIn: resolveDownloadURLExpiry(expiresIn),
  });
  return { ok: true, value };
}
