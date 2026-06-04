/**
 * The internal HTTP/1.1 engine on Bun's raw TCP sockets (`Bun.listen`) — the TypeScript
 * analogue of CodeGreen's Netty engine. Drives the Glyph11 parser, streams large request
 * bodies straight off the connection, and supports keep-alive + pipelining.
 */
import type { Socket } from "bun";
import {
  ConnectionHandling,
  ContentType,
  type Handler,
  type HandlerBuilder,
  HttpProtocol,
  type Request,
  type RequestBody,
  type RequestHeader,
  RequestTarget,
  type Response,
  ResponseStatus,
  type Server,
  type ServerHost,
} from "../../api/index.ts";
import {
  BufferedRequestBody,
  type BodySource,
  concatChunks,
  DEFAULT_NETWORK,
  type NetworkConfiguration,
  RequestImpl,
  StreamingRequestBody,
} from "../shared/index.ts";
import {
  BodyFraming,
  DEFAULT_LIMITS,
  detectFraming,
  HttpParseException,
  indexOfHeaderEnd,
  type ParsedHeader,
  parseHeader,
  type ParserLimits,
} from "../../glyph11/index.ts";

const encoder = new TextEncoder();

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------- request header

class RequestHeaderImpl implements RequestHeader {
  readonly target: RequestTarget;
  constructor(private readonly parsed: ParsedHeader) {
    this.target = new RequestTarget(parsed.path);
  }
  get method() { return this.parsed.method; }
  get path() { return this.parsed.path; }
  get protocol() { return this.parsed.protocol; }
  get headers() { return this.parsed.headers; }
  get query() { return this.parsed.query; }
}

// ---------------------------------------------------------------------------- connection reader

/**
 * Buffers inbound bytes from the socket and exposes async reads. Acts as the [BodySource] for
 * streamed bodies (consumer-paced pull) so large bodies are never fully buffered.
 */
class ConnectionReader implements BodySource {
  private leftover: Uint8Array | null = null;
  private readonly queue: Uint8Array[] = [];
  private waiter: ((value: Uint8Array | null) => void) | null = null;
  private closed = false;

  feed(chunk: Uint8Array): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(chunk);
    } else {
      this.queue.push(chunk);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  private pullRaw(): Promise<Uint8Array | null> {
    if (this.leftover) {
      const l = this.leftover;
      this.leftover = null;
      return Promise.resolve(l);
    }
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as Uint8Array);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** BodySource: up to `maxBytes` (one chunk), unreading any remainder. */
  async read(maxBytes: number): Promise<Uint8Array | null> {
    const chunk = await this.pullRaw();
    if (chunk === null) return null;
    if (chunk.length > maxBytes) {
      this.leftover = chunk.subarray(maxBytes);
      return chunk.subarray(0, maxBytes);
    }
    return chunk;
  }

  async readHeaderBlock(limits: ParserLimits): Promise<Uint8Array | null> {
    let acc: Uint8Array | null = null;
    for (;;) {
      const chunk = await this.pullRaw();
      if (chunk === null) return null;
      acc = acc === null ? chunk : concat(acc, chunk);
      const end = indexOfHeaderEnd(acc, acc.length);
      if (end >= 0) {
        const header = acc.subarray(0, end);
        const rest = acc.subarray(end);
        if (rest.length > 0) this.leftover = rest;
        return header;
      }
      if (acc.length > limits.maxHeaderBytes) throw new HttpParseException("Header block exceeds limit", 431);
    }
  }

  async readExact(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = await this.read(n - filled);
      if (chunk === null) throw new HttpParseException("Connection closed before the body completed");
      out.set(chunk, filled);
      filled += chunk.length;
    }
    return out;
  }

  private async readByte(): Promise<number> {
    const b = await this.read(1);
    if (b === null) throw new HttpParseException("Connection closed mid-body");
    return b[0] as number;
  }

  private async readLine(): Promise<string> {
    const bytes: number[] = [];
    for (;;) {
      const b = await this.readByte();
      if (b === 13) {
        if ((await this.readByte()) !== 10) throw new HttpParseException("Malformed chunk line");
        return String.fromCharCode(...bytes);
      }
      bytes.push(b);
    }
  }

  async readChunkedBody(limits: NetworkConfiguration): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const size = parseInt(((await this.readLine()).split(";")[0] ?? "").trim(), 16);
      if (Number.isNaN(size)) throw new HttpParseException("Invalid chunk size");
      if (size === 0) {
        await this.readLine();
        break;
      }
      parts.push(await this.readExact(size));
      await this.readExact(2); // trailing CRLF
      total += size;
      if (total > limits.requestMemoryLimit * 64) throw new HttpParseException("Chunked body too large", 413);
    }
    return concatChunks(parts, total);
  }
}

interface ConnData {
  reader: ConnectionReader;
}

// ---------------------------------------------------------------------------- response writing

async function renderResponse(request: Request, response: Response, keepAlive: boolean): Promise<Uint8Array> {
  const head = request.header.method === "HEAD";

  const chunks: Uint8Array[] = [];
  let bodyLength = 0;
  if (response.content) {
    await response.content.write({
      write(data) {
        const bytes = typeof data === "string" ? encoder.encode(data) : data;
        chunks.push(bytes);
        bodyLength += bytes.length;
      },
    });
  }

  let header = `HTTP/1.1 ${response.status.code} ${response.status.phrase}\r\n`;
  header += `Server: Seagreen\r\n`;
  header += `Date: ${new Date().toUTCString()}\r\n`;
  if (response.contentType) header += `Content-Type: ${response.contentType.raw}\r\n`;
  for (const [name, value] of response.headers.entries()) header += `${name}: ${value}\r\n`;
  header += `Content-Length: ${bodyLength}\r\n`;
  if (!keepAlive) header += `Connection: close\r\n`;
  header += `\r\n`;

  const headerBytes = encoder.encode(header);
  if (head || bodyLength === 0) return headerBytes;
  return concatChunks([headerBytes, ...chunks], headerBytes.length + bodyLength);
}

function renderError(status: number, phrase: string, message: string): Uint8Array {
  const body = encoder.encode(message);
  const header =
    `HTTP/1.1 ${status} ${phrase}\r\n` +
    `Server: Seagreen\r\n` +
    `Content-Type: text/plain\r\n` +
    `Content-Length: ${body.length}\r\n` +
    `Connection: close\r\n\r\n`;
  return concat(encoder.encode(header), body);
}

function contentTypeOf(header: ParsedHeader): ContentType | null {
  const ct = header.headers.get("Content-Type");
  return ct ? new ContentType(ct) : null;
}

function wantsKeepAlive(header: ParsedHeader): boolean {
  const connection = header.headers.get("Connection")?.toLowerCase();
  return header.protocol === HttpProtocol.Http10 ? connection === "keep-alive" : connection !== "close";
}

// ---------------------------------------------------------------------------- connection loop

async function runConnection(
  socket: Socket<ConnData>,
  reader: ConnectionReader,
  handler: Handler,
  server: Server,
  development: boolean,
): Promise<void> {
  try {
    for (;;) {
      const headerBytes = await reader.readHeaderBlock(DEFAULT_LIMITS);
      if (headerBytes === null) return; // connection closed cleanly

      let parsed: ParsedHeader;
      let framing;
      try {
        parsed = parseHeader(headerBytes, DEFAULT_LIMITS);
        framing = detectFraming(parsed);
      } catch (e) {
        const status = e instanceof HttpParseException ? e.statusCode : 400;
        socket.write(renderError(status, status === 431 ? "Request Header Fields Too Large" : "Bad Request", development ? String((e as Error).message) : "Bad Request"));
        socket.end();
        return;
      }

      let body: RequestBody | null = null;
      if (framing.framing === BodyFraming.ContentLength) {
        body =
          framing.contentLength <= DEFAULT_NETWORK.requestMemoryLimit
            ? new BufferedRequestBody(contentTypeOf(parsed), await reader.readExact(framing.contentLength))
            : new StreamingRequestBody(reader, contentTypeOf(parsed), framing.contentLength);
      } else if (framing.framing === BodyFraming.Chunked) {
        body = new BufferedRequestBody(contentTypeOf(parsed), await reader.readChunkedBody(DEFAULT_NETWORK));
      }

      const request = new RequestImpl(server, new RequestHeaderImpl(parsed), body);
      const clientKeepAlive = wantsKeepAlive(parsed);

      let response: Response;
      try {
        response = (await handler.handle(request)) ?? request.respond().status(ResponseStatus.NotFound).build();
      } catch (e) {
        const provider = e as { status?: ResponseStatus; message?: string };
        if (provider?.status instanceof ResponseStatus) {
          response = request.respond().status(provider.status).build();
        } else {
          response = request.respond().status(ResponseStatus.InternalServerError).build();
        }
      }

      // Discard any unread body so the next pipelined request starts cleanly (GenHTTP's DrainAsync).
      if (body) await body.drain();

      const keepAlive = clientKeepAlive && response.connection !== ConnectionHandling.Close;
      socket.write(await renderResponse(request, response, keepAlive));

      if (!keepAlive) {
        socket.end();
        return;
      }
    }
  } catch {
    try {
      socket.end();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------- host

class ServerHostImpl implements ServerHost {
  private _handler: Handler | null = null;
  private _host = "0.0.0.0";
  private _port = 8080;
  private _development = false;
  private listener: { stop(closeActiveConnections?: boolean): void } | null = null;
  private stopRun: (() => void) | null = null;

  handler(handler: Handler | HandlerBuilder): ServerHost {
    this._handler = "handle" in handler ? handler : handler.build();
    return this;
  }
  port(port: number): ServerHost {
    this._port = port;
    return this;
  }
  bind(address: string, port: number): ServerHost {
    this._host = address;
    this._port = port;
    return this;
  }
  development(enabled: boolean): ServerHost {
    this._development = enabled;
    return this;
  }
  console(): ServerHost {
    return this;
  }

  async start(): Promise<ServerHost> {
    const handler = this._handler;
    if (!handler) throw new Error("No handler configured");
    await handler.prepare();
    const server: Server = { handler, development: this._development, version: "0.1.0" };
    const development = this._development;

    // reusePort enables SO_REUSEPORT so multiple worker processes can share the port for
    // multi-core scaling (PORTING.md §9.2). It is valid at runtime but missing from
    // @types/bun, hence the cast.
    this.listener = Bun.listen({
      hostname: this._host,
      port: this._port,
      reusePort: true,
      socket: {
        open: (socket: Socket<ConnData>) => {
          const reader = new ConnectionReader();
          socket.data = { reader };
          void runConnection(socket, reader, handler, server, development);
        },
        data: (socket: Socket<ConnData>, chunk: Uint8Array) => socket.data.reader.feed(chunk),
        close: (socket: Socket<ConnData>) => socket.data.reader.close(),
        error: (socket: Socket<ConnData>) => socket.data.reader.close(),
      },
    } as never) as { stop(closeActiveConnections?: boolean): void };
    return this;
  }

  async stop(): Promise<ServerHost> {
    this.listener?.stop(true);
    this.listener = null;
    this.stopRun?.();
    return this;
  }

  async run(): Promise<number> {
    await this.start();
    await new Promise<void>((resolve) => {
      this.stopRun = resolve;
    });
    return 0;
  }
}

export const Host = {
  create(): ServerHost {
    return new ServerHostImpl();
  },
};
