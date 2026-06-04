/**
 * Engine-agnostic implementations shared by any underlying transport: request/response,
 * request bodies (buffered + streamed), and configuration.
 */
import {
  type ConnectionHandling,
  ContentType,
  FieldCollection,
  type Request,
  type RequestBody,
  type RequestHeader,
  type Response,
  type ResponseBuilder,
  type ResponseContent,
  ResponseStatus,
  type Server,
} from "../../api/index.ts";

// ---------------------------------------------------------------------------- configuration

export interface NetworkConfiguration {
  readonly backlog: number;
  readonly requestMemoryLimit: number; // bodies larger than this are streamed, not buffered
}

export const DEFAULT_NETWORK: NetworkConfiguration = {
  backlog: 1024,
  requestMemoryLimit: 1 << 20, // 1 MB, as in GenHTTP / CodeGreen
};

// ---------------------------------------------------------------------------- request

export class RequestImpl implements Request {
  readonly properties = new Map<string, unknown>();
  private bodyFetched = false;

  constructor(
    readonly server: Server,
    readonly header: RequestHeader,
    private readonly body: RequestBody | null,
  ) {}

  getBody(): RequestBody | null {
    if (this.bodyFetched) return this.body;
    this.bodyFetched = true;
    return this.body;
  }

  respond(): ResponseBuilder {
    return new ResponseBuilderImpl();
  }
}

// ---------------------------------------------------------------------------- response

class ResponseImpl implements Response {
  constructor(
    readonly status: ResponseStatus,
    readonly headers: FieldCollection,
    readonly content: ResponseContent | null,
    readonly contentType: ContentType | null,
    readonly connection: ConnectionHandling | null,
  ) {}
}

export class ResponseBuilderImpl implements ResponseBuilder {
  private _status: ResponseStatus = ResponseStatus.OK;
  private _content: ResponseContent | null = null;
  private _type: ContentType | null = null;
  private _connection: ConnectionHandling | null = null;
  private readonly _headers = new FieldCollection();

  status(status: ResponseStatus): ResponseBuilder {
    this._status = status;
    return this;
  }

  statusCode(code: number, phrase: string): ResponseBuilder {
    this._status = new ResponseStatus(code, phrase);
    return this;
  }

  content(content: ResponseContent): ResponseBuilder {
    this._content = content;
    return this;
  }

  type(type: ContentType): ResponseBuilder {
    this._type = type;
    return this;
  }

  header(name: string, value: string): ResponseBuilder {
    this._headers.set(name, value);
    return this;
  }

  connection(handling: ConnectionHandling): ResponseBuilder {
    this._connection = handling;
    return this;
  }

  build(): Response {
    return new ResponseImpl(this._status, this._headers, this._content, this._type ?? this._content?.type ?? null, this._connection);
  }
}

// ---------------------------------------------------------------------------- request bodies

const utf8 = new TextDecoder("utf-8");

/** A fully-buffered body (bodies up to the request memory limit). */
export class BufferedRequestBody implements RequestBody {
  constructor(
    readonly type: ContentType | null,
    private readonly data: Uint8Array,
  ) {}

  get length(): number {
    return this.data.length;
  }

  async *chunks(): AsyncIterable<Uint8Array> {
    yield this.data;
  }

  async bytes(): Promise<Uint8Array> {
    return this.data;
  }

  async text(): Promise<string> {
    return utf8.decode(this.data);
  }

  async drain(): Promise<void> {}
}

/** A pull source over the connection: returns up to `maxBytes` bytes, or null at EOF. */
export interface BodySource {
  read(maxBytes: number): Promise<Uint8Array | null>;
}

/** Collects a sequence of chunks into one Uint8Array. */
export function concatChunks(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * A body streamed straight off the connection — the analogue of GenHTTP's LengthLimitedStream.
 * It pulls bytes from the connection on demand (consumer-paced, never buffering the whole
 * body); `drain()` discards anything the handler left unread so keep-alive stays clean.
 */
export class StreamingRequestBody implements RequestBody {
  private remaining: number;

  constructor(
    private readonly source: BodySource,
    readonly type: ContentType | null,
    readonly length: number,
  ) {
    this.remaining = length;
  }

  async *chunks(): AsyncIterable<Uint8Array> {
    while (this.remaining > 0) {
      const chunk = await this.source.read(this.remaining);
      if (chunk === null) throw new Error("Connection closed before the request body completed");
      this.remaining -= chunk.length;
      yield chunk;
    }
  }

  async bytes(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.chunks()) {
      parts.push(chunk);
      total += chunk.length;
    }
    return concatChunks(parts, total);
  }

  async text(): Promise<string> {
    return utf8.decode(await this.bytes());
  }

  async drain(): Promise<void> {
    while (this.remaining > 0) {
      const chunk = await this.source.read(this.remaining);
      if (chunk === null) break;
      this.remaining -= chunk.length;
    }
  }
}
