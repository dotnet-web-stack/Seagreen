/**
 * Acceptance-test harness: starts the real internal engine on a free loopback port and drives
 * it over `fetch` (normal requests) or a raw TCP socket (malformed/smuggling cases).
 */
import type { Handler, HandlerBuilder, ServerHost } from "../api/index.ts";
import { Host } from "../engine/internal/index.ts";
import { decodeLatin1 } from "../glyph11/index.ts";

export class TestResponse {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly body: string,
  ) {}
  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {}, close() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function parseRaw(text: string): TestResponse {
  const headerEnd = text.indexOf("\r\n\r\n");
  const head = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const lines = head.split("\r\n");
  const statusParts = (lines[0] ?? "").split(" ");
  const status = Number.parseInt(statusParts[1] ?? "0", 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return new TestResponse(status, headers, headerEnd < 0 ? "" : text.slice(headerEnd + 4));
}

export class TestHost {
  private constructor(
    private readonly host: ServerHost,
    readonly port: number,
  ) {}

  static async run(handler: Handler | HandlerBuilder): Promise<TestHost> {
    const port = freePort();
    const host = Host.create().handler(handler).bind("127.0.0.1", port);
    await host.start();
    return new TestHost(host, port);
  }

  async request(path = "/", options: RequestOptions = {}): Promise<TestResponse> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return new TestResponse(res.status, headers, await res.text());
  }

  /** Sends a fully pre-formed raw request (for malformed/smuggling scenarios). */
  async raw(rawRequest: string): Promise<TestResponse> {
    return await new Promise<TestResponse>((resolve, reject) => {
      let buffer = new Uint8Array(0);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(parseRaw(decodeLatin1(buffer)));
      };
      Bun.connect({
        hostname: "127.0.0.1",
        port: this.port,
        socket: {
          open(socket) {
            socket.write(rawRequest);
          },
          data(_socket, chunk) {
            const next = new Uint8Array(buffer.length + chunk.length);
            next.set(buffer);
            next.set(chunk, buffer.length);
            buffer = next;
          },
          close: finish,
          error: finish,
        },
      }).catch(reject);
      setTimeout(finish, 1500);
    });
  }

  async close(): Promise<void> {
    await this.host.stop();
  }
}
