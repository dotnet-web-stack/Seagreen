/**
 * Public API contracts — the TypeScript equivalent of GenHTTP.Api / CodeGreen's :api.
 * Implementations live in engine/ and modules/. MemoryView maps to Uint8Array (zero-copy
 * slices via .subarray); suspend maps to async/Promise.
 */

export type MemoryView = Uint8Array;

// ---------------------------------------------------------------------------- ContentType

export class ContentType {
  constructor(readonly raw: string) {}

  static readonly TextPlain = new ContentType("text/plain");
  static readonly TextHtml = new ContentType("text/html");
  static readonly ApplicationJson = new ContentType("application/json");
  static readonly ApplicationOctetStream = new ContentType("application/octet-stream");
  static readonly ApplicationForceDownload = new ContentType("application/force-download");
  static readonly ApplicationWwwFormUrlEncoded = new ContentType("application/x-www-form-urlencoded");

  withoutOptions(): ContentType {
    const i = this.raw.indexOf(";");
    return i < 0 ? this : new ContentType(this.raw.slice(0, i).trim());
  }

  equals(other: ContentType): boolean {
    return this.withoutOptions().raw.toLowerCase() === other.withoutOptions().raw.toLowerCase();
  }

  toString(): string {
    return this.raw;
  }
}

// ---------------------------------------------------------------------------- Status / protocol

export class ResponseStatus {
  constructor(readonly code: number, readonly phrase: string) {}

  static readonly OK = new ResponseStatus(200, "OK");
  static readonly Created = new ResponseStatus(201, "Created");
  static readonly NoContent = new ResponseStatus(204, "No Content");
  static readonly MovedPermanently = new ResponseStatus(301, "Moved Permanently");
  static readonly Found = new ResponseStatus(302, "Found");
  static readonly SeeOther = new ResponseStatus(303, "See Other");
  static readonly TemporaryRedirect = new ResponseStatus(307, "Temporary Redirect");
  static readonly PermanentRedirect = new ResponseStatus(308, "Permanent Redirect");
  static readonly BadRequest = new ResponseStatus(400, "Bad Request");
  static readonly Unauthorized = new ResponseStatus(401, "Unauthorized");
  static readonly Forbidden = new ResponseStatus(403, "Forbidden");
  static readonly NotFound = new ResponseStatus(404, "Not Found");
  static readonly MethodNotAllowed = new ResponseStatus(405, "Method Not Allowed");
  static readonly UnsupportedMediaType = new ResponseStatus(415, "Unsupported Media Type");
  static readonly UnprocessableEntity = new ResponseStatus(422, "Unprocessable Entity");
  static readonly InternalServerError = new ResponseStatus(500, "Internal Server Error");
}

export enum HttpProtocol {
  Http10 = "HTTP/1.0",
  Http11 = "HTTP/1.1",
}

export enum ConnectionHandling {
  KeepAlive = "keep-alive",
  Close = "close",
  Upgrade = "upgrade",
}

// ---------------------------------------------------------------------------- header maps

/** Case-insensitive multi-map preserving the first value per key (sufficient for HTTP/1.1 here). */
export class FieldCollection {
  private readonly map = new Map<string, string>();
  private readonly keys = new Map<string, string>();

  set(name: string, value: string): void {
    const lower = name.toLowerCase();
    this.map.set(lower, value);
    this.keys.set(lower, name);
  }

  get(name: string): string | undefined {
    return this.map.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [lower, value] of this.map) yield [this.keys.get(lower) ?? lower, value];
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------- routing target

/**
 * Routing cursor over the request path. Layouting/webservices advance it as they descend the
 * handler tree (the analogue of CodeGreen's RequestTarget).
 */
export class RequestTarget {
  readonly segments: string[];
  private index = 0;

  constructor(readonly path: string) {
    this.segments = path.split("/").filter((s) => s.length > 0).map(safeDecode);
  }

  get current(): string | undefined {
    return this.segments[this.index];
  }

  get remaining(): string[] {
    return this.segments.slice(this.index);
  }

  get isLast(): boolean {
    return this.index >= this.segments.length;
  }

  advance(count = 1): void {
    this.index += count;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------- request / body

export interface RequestHeader {
  readonly method: string;
  readonly path: string;
  readonly protocol: HttpProtocol;
  readonly headers: FieldCollection;
  readonly query: FieldCollection;
  readonly target: RequestTarget;
}

export interface RequestBody {
  readonly type: ContentType | null;
  readonly length: number | null;
  /** Streams the body in chunks (read off the event loop where it matters). */
  chunks(): AsyncIterable<Uint8Array>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  /** Discards any unread bytes so a keep-alive connection stays clean (GenHTTP's DrainAsync). */
  drain(): Promise<void>;
}

export interface Request {
  readonly server: Server;
  readonly header: RequestHeader;
  readonly properties: Map<string, unknown>;
  getBody(): RequestBody | null;
  respond(): ResponseBuilder;
}

// ---------------------------------------------------------------------------- response

export interface ResponseWriter {
  write(data: Uint8Array | string): void;
}

export interface ResponseContent {
  readonly length: number | null;
  readonly type: ContentType;
  write(writer: ResponseWriter): Promise<void> | void;
}

export interface Response {
  readonly status: ResponseStatus;
  readonly headers: FieldCollection;
  readonly content: ResponseContent | null;
  readonly contentType: ContentType | null;
  readonly connection: ConnectionHandling | null;
}

export interface ResponseBuilder {
  status(status: ResponseStatus): ResponseBuilder;
  statusCode(code: number, phrase: string): ResponseBuilder;
  content(content: ResponseContent): ResponseBuilder;
  type(type: ContentType): ResponseBuilder;
  header(name: string, value: string): ResponseBuilder;
  connection(handling: ConnectionHandling): ResponseBuilder;
  build(): Response;
}

// ---------------------------------------------------------------------------- content / handlers

export interface Handler {
  prepare(): Promise<void>;
  handle(request: Request): Promise<Response | null>;
}

export interface HandlerBuilder {
  build(): Handler;
}

/** A builder that also accepts concerns and narrows its own type for fluent chaining. */
export interface TypedHandlerBuilder<T extends TypedHandlerBuilder<T>> extends HandlerBuilder {
  add(concern: ConcernBuilder): T;
}

export interface Concern extends Handler {
  readonly content: Handler;
}

export interface ConcernBuilder {
  build(content: Handler): Concern;
}

/**
 * Thrown by content providers to return a specific status instead of a 500.
 */
export class ProviderException extends Error {
  constructor(
    readonly status: ResponseStatus,
    message: string,
    readonly modifications?: (builder: ResponseBuilder) => void,
  ) {
    super(message);
    this.name = "ProviderException";
  }
}

// ---------------------------------------------------------------------------- infrastructure

export interface EndPoint {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
}

export interface Server {
  readonly handler: Handler;
  readonly development: boolean;
  readonly version: string;
}

export interface ServerHost {
  handler(handler: Handler | HandlerBuilder): ServerHost;
  port(port: number): ServerHost;
  bind(address: string, port: number): ServerHost;
  development(enabled: boolean): ServerHost;
  console(): ServerHost;
  /** Starts and returns immediately. */
  start(): Promise<ServerHost>;
  /** Stops the running server. */
  stop(): Promise<ServerHost>;
  /** Starts and blocks until the process exits. */
  run(): Promise<number>;
}
