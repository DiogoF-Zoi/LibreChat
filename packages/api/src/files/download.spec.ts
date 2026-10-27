import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { resolveFileDownloadURL, DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS } from './download';

const expiresAt = new Date('2026-10-23T11:00:00.000Z');

function createStrategy() {
  const getDownloadURL = jest
    .fn()
    .mockResolvedValue({ url: 'https://bucket.s3.amazonaws.com/k?X-Amz-Signature=x', expiresAt });
  const getStrategyFunctions = jest.fn().mockReturnValue({ getDownloadURL });
  return { getDownloadURL, getStrategyFunctions };
}

const s3File = {
  file_id: 'file-1',
  filename: 'doc.pdf',
  filepath: 'uploads/user-1/doc.pdf',
  source: FileSources.s3,
  type: 'application/pdf',
} as TFile;

describe('resolveFileDownloadURL', () => {
  it('signs through the file source strategy with the requested expiry', async () => {
    const { getDownloadURL, getStrategyFunctions } = createStrategy();

    const result = await resolveFileDownloadURL({
      file: s3File,
      filename: 'doc.pdf',
      expiresIn: 900,
      getStrategyFunctions,
    });

    expect(result).toEqual({
      ok: true,
      value: { url: 'https://bucket.s3.amazonaws.com/k?X-Amz-Signature=x', expiresAt },
    });
    expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.s3);
    expect(getDownloadURL).toHaveBeenCalledWith(
      expect.objectContaining({
        file: s3File,
        customFilename: 'doc.pdf',
        contentType: 'application/pdf',
        expiresIn: 900,
      }),
    );
  });

  it('defaults to 300 seconds when no expiry is configured', async () => {
    const { getDownloadURL, getStrategyFunctions } = createStrategy();

    await resolveFileDownloadURL({ file: s3File, filename: 'doc.pdf', getStrategyFunctions });

    expect(getDownloadURL).toHaveBeenCalledWith(
      expect.objectContaining({ expiresIn: DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS }),
    );
    expect(DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS).toBe(300);
  });

  it('falls back to a generic content type', async () => {
    const { getDownloadURL, getStrategyFunctions } = createStrategy();

    await resolveFileDownloadURL({
      file: { ...s3File, type: '' },
      filename: 'doc.pdf',
      getStrategyFunctions,
    });

    expect(getDownloadURL).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'application/octet-stream' }),
    );
  });

  it.each([FileSources.local, FileSources.azure_blob, FileSources.firebase])(
    'returns unsupported_source when %s has no getDownloadURL',
    async (source) => {
      const getStrategyFunctions = jest.fn().mockReturnValue({});

      const result = await resolveFileDownloadURL({
        file: { ...s3File, source },
        filename: 'doc.pdf',
        getStrategyFunctions,
      });

      expect(result).toEqual({ ok: false, error: { code: 'unsupported_source' } });
    },
  );

  it('returns missing_model for OpenAI-stored files without a model', async () => {
    const { getStrategyFunctions } = createStrategy();

    const result = await resolveFileDownloadURL({
      file: { ...s3File, source: FileSources.openai },
      filename: 'doc.pdf',
      getStrategyFunctions,
    });

    expect(result).toEqual({ ok: false, error: { code: 'missing_model' } });
    expect(getStrategyFunctions).not.toHaveBeenCalled();
  });

  it('returns unsupported_source for OpenAI-stored files with a model', async () => {
    const { getStrategyFunctions } = createStrategy();

    const result = await resolveFileDownloadURL({
      file: { ...s3File, source: FileSources.openai, model: 'gpt-4o' },
      filename: 'doc.pdf',
      getStrategyFunctions,
    });

    expect(result).toEqual({ ok: false, error: { code: 'unsupported_source' } });
    expect(getStrategyFunctions).not.toHaveBeenCalled();
  });

  it('propagates signing failures', async () => {
    const getDownloadURL = jest.fn().mockRejectedValue(new Error('S3 not initialized'));
    const getStrategyFunctions = jest.fn().mockReturnValue({ getDownloadURL });

    await expect(
      resolveFileDownloadURL({ file: s3File, filename: 'doc.pdf', getStrategyFunctions }),
    ).rejects.toThrow('S3 not initialized');
  });
});
