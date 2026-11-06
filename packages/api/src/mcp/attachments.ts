import crypto from 'node:crypto';
import type { MCPAttachmentURLs, TFile } from 'librechat-data-provider';
import type { FileDownloadURLStrategy } from '~/files/download';
import { resolveDownloadURLExpiry, resolveFileDownloadURL } from '~/files/download';
import { stripFileIdPrefix } from '~/storage/path';

/** Run `configurable` key carrying the turn's references from message building to tool calls. */
export const MCP_ATTACHMENT_REFS_KEY = 'mcpAttachmentRefs';

const REF_SCHEME = 'attachment://';
const DEFAULT_MIN_TTL_SECONDS = 60;
const MAX_FILENAME_LENGTH = 200;
const MAX_ECHOED_REF_LENGTH = 120;
/** Deep enough for any tool schema; deeper values pass through untouched. */
const MAX_VALUE_DEPTH = 32;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

export type MCPAttachmentErrorCode =
  | 'unknown_reference'
  | 'unsupported_type'
  | 'unsupported_source'
  | 'insufficient_ttl';

const ATTACHMENT_ERROR_MESSAGES: Record<MCPAttachmentErrorCode, (ref: string) => string> = {
  unknown_reference: (ref) =>
    `Attachment reference "${ref}" is not available in this turn. References only work in the turn they were listed; ask the user to attach the file again.`,
  unsupported_type: (ref) => `This tool does not accept the file type of attachment "${ref}".`,
  unsupported_source: (ref) => `Attachment "${ref}" cannot be shared with tools.`,
  insufficient_ttl: (ref) =>
    `A download link for attachment "${ref}" could not be issued for long enough. Try again.`,
};

/** Messages are model-safe: they name the reference the model sent, never a URL or record id. */
export class MCPAttachmentError extends Error {
  readonly code: MCPAttachmentErrorCode;

  constructor(code: MCPAttachmentErrorCode, ref: string) {
    const shown =
      ref.length > MAX_ECHOED_REF_LENGTH ? `${ref.slice(0, MAX_ECHOED_REF_LENGTH)}…` : ref;
    super(ATTACHMENT_ERROR_MESSAGES[code](shown));
    this.name = 'MCPAttachmentError';
    this.code = code;
  }
}

type AttachmentFile = TFile & { tenantId?: string | null };

interface AttachmentEntry {
  ref: string;
  file: AttachmentFile;
  filename: string;
  type: string;
}

export interface MCPAttachmentRefsParams {
  /** Hydrated request attachments; each is re-checked against the owner and the request's ids. */
  files: ReadonlyArray<AttachmentFile | null | undefined>;
  /** File ids the user attached to this message; anything else is not this turn's attachment. */
  requestFileIds: Iterable<string>;
  owner: { userId: string; tenantId?: string | null };
  getStrategyFunctions: (source: string) => FileDownloadURLStrategy;
  /** `fileConfig.downloadUrlExpiry`; a server's own `attachmentUrls.expiry` takes precedence. */
  defaultExpiry?: number;
  /** Resolves a server's config for the acting user, used to decide which agents see the list. */
  getServerConfig: (
    serverName: string,
  ) => Promise<{ attachmentUrls?: MCPAttachmentURLs } | null | undefined>;
  nonce?: string;
  now?: () => number;
}

const isSameId = (a: unknown, b: unknown): boolean => a != null && b != null && `${a}` === `${b}`;

function matchesMimeType(type: string, accepted: string[] | undefined): boolean {
  if (!accepted) {
    return true;
  }
  const normalized = type.toLowerCase().split(';')[0].trim();
  const [major] = normalized.split('/');
  return accepted.some((pattern) =>
    pattern.endsWith('/*') ? `${major}/*` === pattern : pattern === normalized,
  );
}

function displayName(filename: string | undefined): string {
  const cleaned = stripFileIdPrefix(filename ?? '')
    .replace(CONTROL_CHARACTERS, ' ')
    .trim();
  const name = cleaned || 'attachment';
  return name.length > MAX_FILENAME_LENGTH ? `${name.slice(0, MAX_FILENAME_LENGTH)}…` : name;
}

/**
 * The current turn's attachments, addressed by opaque references. It holds file records and
 * mints URLs on demand; it never stores a URL. Fields are private so neither serialization nor
 * logging of the run config exposes the records.
 */
export class MCPAttachmentRefs {
  readonly #entries: Map<string, AttachmentEntry>;
  readonly #getStrategyFunctions: MCPAttachmentRefsParams['getStrategyFunctions'];
  readonly #getServerConfig: MCPAttachmentRefsParams['getServerConfig'];
  readonly #defaultExpiry: number | undefined;
  readonly #now: () => number;

  constructor(entries: AttachmentEntry[], params: MCPAttachmentRefsParams) {
    this.#entries = new Map(entries.map((entry) => [entry.ref, entry]));
    this.#getStrategyFunctions = params.getStrategyFunctions;
    this.#getServerConfig = params.getServerConfig;
    this.#defaultExpiry = params.defaultExpiry;
    this.#now = params.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  toJSON(): { size: number } {
    return { size: this.size };
  }

  /** References a server with this config accepts. */
  accepted(config: MCPAttachmentURLs | undefined): AttachmentEntry[] {
    if (!config) {
      return [];
    }
    return [...this.#entries.values()].filter((entry) =>
      matchesMimeType(entry.type, config.mimeTypes),
    );
  }

  /**
   * Lists the references any of `serverNames` accepts, for the agent's system tail, or `''` when
   * none of its servers takes attachments.
   */
  async formatContext(serverNames: string[]): Promise<string> {
    if (this.size === 0 || serverNames.length === 0) {
      return '';
    }
    const configs = await Promise.all(
      serverNames.map(async (name) => [name, await this.#getServerConfig(name)] as const),
    );
    const accepting = new Map<string, string[]>();
    for (const [serverName, config] of configs) {
      for (const entry of this.accepted(config?.attachmentUrls)) {
        accepting.set(entry.ref, [...(accepting.get(entry.ref) ?? []), serverName]);
      }
    }
    if (accepting.size === 0) {
      return '';
    }
    const lines = [...this.#entries.values()]
      .filter((entry) => accepting.has(entry.ref))
      .map(
        (entry) =>
          `- ${entry.ref}: ${JSON.stringify(entry.filename)} (${entry.type}); accepted by: ${accepting.get(entry.ref)?.join(', ')}`,
      );
    return [
      '# Attached Files',
      'The user attached these files to their latest message. When a tool from an accepting server asks for file URLs (for example a `file_urls` argument), pass the reference exactly as written in place of the URL. It is exchanged for a short-lived download link only when the tool runs, and it is valid for this turn only.',
      ...lines,
    ].join('\n');
  }

  /** Mints a URL for one reference under a server's policy; throws `MCPAttachmentError`. */
  async mint(ref: string, config: MCPAttachmentURLs): Promise<string> {
    const entry = this.#entries.get(ref);
    if (!entry) {
      throw new MCPAttachmentError('unknown_reference', ref);
    }
    if (!matchesMimeType(entry.type, config.mimeTypes)) {
      throw new MCPAttachmentError('unsupported_type', ref);
    }
    const expiresIn = resolveDownloadURLExpiry(config.expiry ?? this.#defaultExpiry);
    const result = await resolveFileDownloadURL({
      file: entry.file,
      filename: entry.filename,
      expiresIn,
      getStrategyFunctions: this.#getStrategyFunctions,
    });
    if (!result.ok) {
      throw new MCPAttachmentError('unsupported_source', ref);
    }
    const minTtlMs = Math.min(config.minTtl ?? DEFAULT_MIN_TTL_SECONDS, expiresIn) * 1000;
    if (result.value.expiresAt.getTime() - this.#now() < minTtlMs) {
      throw new MCPAttachmentError('insufficient_ttl', ref);
    }
    return result.value.url;
  }
}

/**
 * Builds the turn's references from the request's attachments, or `undefined` when none can be
 * handed to a tool. Only files the user attached to this message, owned by the acting user in
 * their tenant, and stored where a download URL can be signed are listed.
 */
export function createMCPAttachmentRefs(
  params: MCPAttachmentRefsParams,
): MCPAttachmentRefs | undefined {
  const requestFileIds = new Set(params.requestFileIds);
  if (requestFileIds.size === 0) {
    return undefined;
  }
  const nonce = params.nonce ?? crypto.randomBytes(4).toString('hex');
  const seen = new Set<string>();
  const entries: AttachmentEntry[] = [];
  for (const file of params.files) {
    if (
      !file?.file_id ||
      seen.has(file.file_id) ||
      !requestFileIds.has(file.file_id) ||
      !isSameId(file.user, params.owner.userId) ||
      (file.tenantId ?? null) !== (params.owner.tenantId ?? null) ||
      !file.source ||
      !params.getStrategyFunctions(file.source).getDownloadURL
    ) {
      continue;
    }
    seen.add(file.file_id);
    entries.push({
      ref: `${REF_SCHEME}${nonce}/${entries.length + 1}`,
      file,
      filename: displayName(file.filename),
      type: (file.type || 'application/octet-stream').toLowerCase(),
    });
  }
  return entries.length > 0 ? new MCPAttachmentRefs(entries, params) : undefined;
}

type Mapper = (value: string) => string;

/** Copies plain JSON containers, mapping strings; anything else is returned as is. */
function mapStrings(value: unknown, map: Mapper, depth = 0): unknown {
  if (typeof value === 'string') {
    return map(value);
  }
  if (depth >= MAX_VALUE_DEPTH || value == null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, map, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = mapStrings(item, map, depth + 1);
  }
  return copy;
}

function collectRefs(value: unknown, refs: Set<string>, depth = 0): void {
  if (typeof value === 'string') {
    if (value.startsWith(REF_SCHEME)) {
      refs.add(value);
    }
    return;
  }
  if (depth >= MAX_VALUE_DEPTH || value == null || typeof value !== 'object') {
    return;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectRefs(item, refs, depth + 1);
  }
}

/** Every spelling of a minted URL a server might echo: as is, JSON-escaped, or its query alone. */
function urlSpellings(url: string): string[] {
  const spellings = [url, url.replace(/\//g, '\\/')];
  const queryIndex = url.indexOf('?');
  if (queryIndex !== -1 && queryIndex < url.length - 1) {
    spellings.push(url.slice(queryIndex));
  }
  return spellings;
}

export interface MCPAttachmentCallParams<T> {
  /** Read from the run's `configurable`; anything but a live instance counts as no references. */
  refs: unknown;
  serverConfig: { attachmentUrls?: MCPAttachmentURLs } | null | undefined;
  toolArguments: unknown;
  call: (toolArguments: unknown) => Promise<T>;
}

/**
 * Runs an MCP tool call with this turn's attachment references swapped for freshly signed URLs.
 * Only servers with `attachmentUrls` get URLs; for others the arguments pass through unchanged.
 * The caller's arguments are not mutated, so stored and streamed tool calls keep the reference,
 * and any minted URL the server echoes back is replaced with its reference before returning.
 */
export async function callWithMCPAttachments<T>({
  refs,
  serverConfig,
  toolArguments,
  call,
}: MCPAttachmentCallParams<T>): Promise<T> {
  const config = serverConfig?.attachmentUrls;
  if (!config) {
    return call(toolArguments);
  }
  const requested = new Set<string>();
  collectRefs(toolArguments, requested);
  if (requested.size === 0) {
    return call(toolArguments);
  }
  const turnRefs = refs instanceof MCPAttachmentRefs ? refs : undefined;
  const minted = new Map<string, string>();
  await Promise.all(
    [...requested].map(async (ref) => {
      if (!turnRefs) {
        throw new MCPAttachmentError('unknown_reference', ref);
      }
      minted.set(ref, await turnRefs.mint(ref, config));
    }),
  );
  const result = await call(mapStrings(toolArguments, (value) => minted.get(value) ?? value));
  const replacements = [...minted].flatMap(([ref, url]) =>
    urlSpellings(url).map((spelling) => [spelling, ref] as const),
  );
  return mapStrings(result, (value) =>
    replacements.reduce(
      (text, [spelling, ref]) => (text.includes(spelling) ? text.split(spelling).join(ref) : text),
      value,
    ),
  ) as T;
}
