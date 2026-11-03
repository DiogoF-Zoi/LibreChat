import { FileSources } from 'librechat-data-provider';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { RequestHandler, Response } from 'express';
import type { Readable } from 'stream';
import type { GetAppConfigOptions } from '~/app/service';
import type { StrategyFunctions } from '~/types/files';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';
import { resolveDownloadPath } from '~/storage/path';
import { verifySignedDownload } from './signed';

/**
 * Sources whose `getDownloadURL` signs a proxy URL. A record from any other source is not
 * served here even under a valid signature, since this server never issued one for it.
 */
const PROXY_DOWNLOAD_SOURCES = new Set<string>([FileSources.local]);

export interface SignedDownloadFile {
  _id?: { toString(): string } | string;
  file_id: string;
  filename: string;
  filepath: string;
  storageKey?: string | null;
  source?: string;
}

export interface SignedDownloadHandlerDeps {
  getSecret: () => string | undefined;
  getFiles: (filter: { _id: string }) => Promise<SignedDownloadFile[] | null>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  getStrategyFunctions: (source: string) => Partial<Pick<StrategyFunctions, 'getDownloadStream'>>;
  getContentDisposition: (filename: string) => string;
}

const sendNotFound = (res: Response) =>
  res.status(404).json({ error: 'Not Found', code: 'file_not_found' });

/**
 * Pipes the file to the response. A source error before the first byte (a record whose bytes
 * are gone) still gets a status; after that the connection is cut. A client that disconnects
 * mid-download destroys the source so the file handle is released.
 */
function pipeToResponse(
  fileStream: Readable,
  res: Response,
  file: SignedDownloadFile,
): Promise<void> {
  return new Promise((resolve) => {
    fileStream.once('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT';
      if (missing) {
        logger.warn(`[signedDownload] Stored bytes missing for file ${file.file_id}`);
      } else {
        logger.error('[signedDownload] Stream error:', getSafeErrorMetadata(error));
      }
      if (res.headersSent) {
        res.destroy();
      } else {
        res.removeHeader('Content-Disposition');
        res.removeHeader('Content-Type');
        if (missing) {
          sendNotFound(res);
        } else {
          res.status(500).json({ error: 'Internal Server Error' });
        }
      }
      resolve();
    });
    res.once('close', () => {
      fileStream.destroy();
      resolve();
    });
    fileStream.pipe(res);
  });
}

/**
 * Serves a file named by a signed download URL. The route is unauthenticated: the signature,
 * checked here, is the whole authorization, granted when the URL was issued to a user who
 * passed the file access checks. The record is looked up outside any tenant context because the
 * caller carries none; the signed id names exactly one record. Nothing from the request URL is
 * logged, since its query string is the credential.
 */
export function createSignedDownloadHandler({
  getSecret,
  getFiles,
  getAppConfig,
  getStrategyFunctions,
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

      const { getDownloadStream } = getStrategyFunctions(source);
      if (!getDownloadStream) {
        sendNotFound(res);
        return;
      }

      /** Storage paths are deployment-wide, so the YAML base config is enough to resolve them. */
      req.config = await getAppConfig({ baseOnly: true });
      const fileStream = await getDownloadStream(req, resolveDownloadPath(file));

      res.setHeader('Content-Disposition', getContentDisposition(file.filename));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      await pipeToResponse(fileStream, res, file);
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
