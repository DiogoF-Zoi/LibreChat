import { FileSources } from 'librechat-data-provider';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { RequestHandler, Response } from 'express';
import type { LocalDownloadFile } from '~/storage/local';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types/http';
import { resolveLocalDownloadPath } from '~/storage/local';
import { getSafeErrorMetadata } from '~/utils/errors';
import { verifySignedDownload } from './signed';

/**
 * Sources whose `getDownloadURL` signs a proxy URL. A record from any other source is not
 * served here even under a valid signature, since this server never issued one for it.
 */
const PROXY_DOWNLOAD_SOURCES = new Set<string>([FileSources.local]);

/** Headers that describe the file body, dropped when an error response replaces it. */
const FILE_BODY_HEADERS = [
  'Accept-Ranges',
  'Content-Disposition',
  'Content-Length',
  'Content-Range',
  'Content-Security-Policy',
  'Content-Type',
  'ETag',
  'Last-Modified',
];

export interface SignedDownloadFile {
  _id?: { toString(): string } | string;
  file_id: string;
  filename: string;
  filepath: string;
  source?: string;
}

export interface SignedDownloadHandlerDeps {
  getSecret: () => string | undefined;
  getFiles: (filter: { _id: string }) => Promise<SignedDownloadFile[] | null>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  getContentDisposition: (filename: string) => string;
}

type SendFileError = Error & {
  code?: string;
  status?: number;
  statusCode?: number;
  headers?: Record<string, string>;
};

const sendNotFound = (res: Response) =>
  res.status(404).json({ error: 'Not Found', code: 'file_not_found' });

const removeFileBodyHeaders = (res: Response) =>
  FILE_BODY_HEADERS.forEach((name) => res.removeHeader(name));

/**
 * A strong validator from size and modification time (nginx's scheme), so `If-Range` can resume
 * a partial download only while the bytes on disk are unchanged.
 */
const getStrongETag = ({ size, mtimeMs }: LocalDownloadFile): string =>
  `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;

/**
 * Streams the file with `res.sendFile`, which reads it through `fs.createReadStream` and handles
 * `Content-Length`, single byte ranges (`206`/`416`), `If-Range`, `Last-Modified`, HEAD and
 * conditional requests, and destroys the read stream when the client disconnects. A failure
 * before the first byte still gets a status; after it, the connection is cut so the client
 * cannot mistake a truncated body for the whole file.
 */
function sendLocalFile(res: Response, local: LocalDownloadFile, fileId: string): Promise<void> {
  return new Promise((resolve) => {
    /** `dotfiles: 'allow'` is safe: the path was already confined to the storage roots. */
    const options = {
      acceptRanges: true,
      cacheControl: false,
      lastModified: true,
      dotfiles: 'allow' as const,
    };
    res.sendFile(local.path, options, (sendError?: Error) => {
      resolve();
      const error = sendError as SendFileError | undefined;
      if (!error) {
        return;
      }
      if (error.code === 'ECONNABORTED') {
        logger.debug(`[signedDownload] Client disconnected during download of file ${fileId}`);
        return;
      }
      if (res.headersSent) {
        logger.error('[signedDownload] Stream error:', getSafeErrorMetadata(error));
        res.destroy();
        return;
      }

      removeFileBodyHeaders(res);
      const status = error.status ?? error.statusCode;
      if (status === 412 || status === 416) {
        Object.entries(error.headers ?? {}).forEach(([name, value]) => res.setHeader(name, value));
        res.status(status).end();
        return;
      }
      if (status === 404 || error.code === 'ENOENT') {
        logger.warn(`[signedDownload] Stored bytes missing for file ${fileId}`);
        sendNotFound(res);
        return;
      }
      logger.error('[signedDownload] Stream error:', getSafeErrorMetadata(error));
      res.status(500).json({ error: 'Internal Server Error' });
    });
  });
}

/**
 * Serves a file named by a signed download URL. The route is unauthenticated: the signature,
 * checked here, is the whole authorization, granted when the URL was issued to a user who
 * passed the file access checks. The record is looked up outside any tenant context because the
 * caller carries none; the signed id names exactly one record. Only files inside the configured
 * storage roots are served. Nothing from the request URL is logged, since its query string is
 * the credential.
 */
export function createSignedDownloadHandler({
  getSecret,
  getFiles,
  getAppConfig,
  getContentDisposition,
}: SignedDownloadHandlerDeps): RequestHandler {
  const handler = async (req: ServerRequest, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      const secret = getSecret();
      if (!secret) {
        throw new Error('[signedDownload] A signing secret is required');
      }

      const { id: requestedId } = req.params as { id?: string };
      const verification = verifySignedDownload({
        secret,
        method: req.method,
        id: requestedId,
        expires: req.query.expires,
        signature: req.query.signature,
      });
      if (!verification.ok) {
        logger.debug(`[signedDownload] Rejected download URL: ${verification.error.code}`);
        res.status(403).json({ error: 'Forbidden', code: verification.error.code });
        return;
      }

      const { id } = verification.value;
      const [file] = (await runAsSystem(async () => getFiles({ _id: id }))) ?? [];
      const source = file?.source ?? FileSources.local;
      if (!file || !PROXY_DOWNLOAD_SOURCES.has(source)) {
        sendNotFound(res);
        return;
      }

      /** Storage paths are deployment-wide, so the YAML base config is enough to resolve them. */
      const { paths } = await getAppConfig({ baseOnly: true });
      if (!paths) {
        throw new Error('[signedDownload] Local storage paths are not configured');
      }
      const resolved = await resolveLocalDownloadPath(file.filepath, paths);
      if (!resolved.ok) {
        logger.warn(
          resolved.error.code === 'outside_storage'
            ? `[signedDownload] File ${file.file_id} is stored outside the servable roots`
            : `[signedDownload] Stored bytes missing for file ${file.file_id}`,
        );
        sendNotFound(res);
        return;
      }

      res.setHeader('Content-Disposition', getContentDisposition(file.filename));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('ETag', getStrongETag(resolved.value));
      await sendLocalFile(res, resolved.value, file.file_id);
    } catch (error) {
      logger.error('[signedDownload] Error serving signed download:', getSafeErrorMetadata(error));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      removeFileBodyHeaders(res);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  };
  return handler as RequestHandler;
}
