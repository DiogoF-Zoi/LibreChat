import { FileSources, checkOpenAIStorage } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { DownloadURLParams, DownloadURLResult } from '~/storage/types';
import type { ServerRequest } from '~/types/http';

export type FileDownloadURLErrorCode = 'unsupported_source' | 'missing_model';

/** Independent of `S3_URL_EXPIRY_SECONDS`, which still governs inline asset URLs. */
export const DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS = 300;

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
 * Signs a short-lived, read-only URL through the file's storage strategy.
 * Sources without `getDownloadURL` resolve to `unsupported_source`; signing failures throw.
 */
export async function resolveFileDownloadURL({
  req,
  file,
  filename,
  expiresIn = DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS,
  getStrategyFunctions,
}: FileDownloadURLRequest): Promise<FileDownloadURLOutcome> {
  const source = file.source ?? FileSources.local;
  if (checkOpenAIStorage(source)) {
    return { ok: false, error: { code: file.model ? 'unsupported_source' : 'missing_model' } };
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
    expiresIn,
  });
  return { ok: true, value };
}
