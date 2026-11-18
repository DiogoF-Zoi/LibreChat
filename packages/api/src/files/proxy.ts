import { FileSources } from 'librechat-data-provider';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { RequestHandler, Response } from 'express';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types/http';
import { formatContentDisposition } from '~/storage/disposition';
import { resolveLocalDownloadPath } from '~/storage/local';
import { getSafeErrorMetadata } from '~/utils/errors';
import { stripFileIdPrefix } from '~/storage/path';
import { verifySignedDownload } from './signed';

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
}

type SendFileError = Error & { code?: string; status?: number; statusCode?: number };

const sendNotFound = (res: Response) =>
  res.status(404).json({ error: 'Not Found', code: 'file_not_found' });

/**
 * `res.sendFile` handles ranges, conditional requests and HEAD, and applies `headers` only when it
 * serves the file, so an error response never carries them. A failure after the headers are sent
 * destroys the connection, so a truncated body is never mistaken for the whole file.
 */
function sendLocalFile(
  res: Response,
  filePath: string,
  headers: Record<string, string>,
  fileId: string,
): Promise<void> {
  return new Promise((resolve) => {
    /** `dotfiles: 'allow'` is safe: the path is already confined to the storage roots. */
    const options = { headers, cacheControl: false, dotfiles: 'allow' as const };
    res.sendFile(filePath, options, (sendError?: Error) => {
      resolve();
      const error = sendError as SendFileError | undefined;
      if (!error || error.code === 'ECONNABORTED') {
        return;
      }
      if (res.headersSent) {
        logger.error('[signedDownload] Stream error:', getSafeErrorMetadata(error));
        res.destroy();
        return;
      }
      const status = error.status ?? error.statusCode;
      /** Range and precondition failures keep the `Content-Range` the file server set. */
      if (status === 412 || status === 416) {
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
 * Serves a file named by a signed download URL. The route is unauthenticated: the signature is
 * the whole authorization, so the record is looked up outside tenant context and nothing from
 * the request URL is logged, since its query string is the credential.
 */
export function createSignedDownloadHandler({
  getSecret,
  getFiles,
  getAppConfig,
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
      /** Only local storage issues these URLs, so no other record is served under a valid signature. */
      if (!file || (file.source ?? FileSources.local) !== FileSources.local) {
        sendNotFound(res);
        return;
      }

      /** Storage paths are deployment-wide, so the base config is enough. */
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

      await sendLocalFile(
        res,
        resolved.value,
        {
          'Content-Disposition': formatContentDisposition(stripFileIdPrefix(file.filename)),
          'Content-Type': 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
        file.file_id,
      );
    } catch (error) {
      logger.error('[signedDownload] Error serving signed download:', getSafeErrorMetadata(error));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(500).json({ error: 'Internal Server Error' });
    }
  };
  return handler as RequestHandler;
}
