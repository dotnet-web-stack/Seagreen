/**
 * Hardened HTTP/1.1 header parser + body-framing detection — the TypeScript port of
 * CodeGreen's :glyph11. Parses/validates the header block only; the engine reads the body
 * (driven by the framing result). Operates over Uint8Array; header fields are decoded as
 * latin1 (HTTP header bytes are ASCII/ISO-8859-1).
 */
import { FieldCollection, HttpProtocol } from "../api/index.ts";

export class HttpParseException extends Error {
  constructor(message: string, readonly statusCode: number = 400) {
    super(message);
    this.name = "HttpParseException";
  }
}

export interface ParserLimits {
  readonly maxHeaderBytes: number;
  readonly maxHeaderCount: number;
  readonly maxRequestLineBytes: number;
}

export const DEFAULT_LIMITS: ParserLimits = {
  maxHeaderBytes: 64 * 1024,
  maxHeaderCount: 200,
  maxRequestLineBytes: 8 * 1024,
};

export enum BodyFraming {
  None,
  ContentLength,
  Chunked,
}

export interface BodyFramingResult {
  readonly framing: BodyFraming;
  readonly contentLength: number;
}

export interface ParsedHeader {
  readonly method: string;
  readonly path: string;
  readonly rawTarget: string;
  readonly protocol: HttpProtocol;
  readonly headers: FieldCollection;
  readonly query: FieldCollection;
}

const CR = 13;
const LF = 10;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Decodes bytes as ISO-8859-1 (HTTP header octets), one byte per char. */
export function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return out;
}

/** Index just past the CRLFCRLF header terminator within `[0, end)`, or -1 if not present yet. */
export function indexOfHeaderEnd(buf: Uint8Array, end: number): number {
  for (let i = 0; i + 3 < end; i++) {
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === CR && buf[i + 3] === LF) return i + 4;
  }
  return -1;
}

export function parseHeader(bytes: Uint8Array, limits: ParserLimits = DEFAULT_LIMITS): ParsedHeader {
  if (bytes.length > limits.maxHeaderBytes) throw new HttpParseException("Header block exceeds limit", 431);

  const text = decodeLatin1(bytes);
  const lines = text.split("\r\n");

  const requestLine = lines[0] ?? "";
  if (requestLine.length > limits.maxRequestLineBytes) throw new HttpParseException("Request line too long", 414);

  const parts = requestLine.split(" ");
  if (parts.length !== 3) throw new HttpParseException("Malformed request line");
  const [method, rawTarget, versionStr] = parts as [string, string, string];

  if (!TOKEN.test(method)) throw new HttpParseException("Invalid request method");

  const protocol =
    versionStr === "HTTP/1.1"
      ? HttpProtocol.Http11
      : versionStr === "HTTP/1.0"
        ? HttpProtocol.Http10
        : null;
  if (protocol === null) throw new HttpParseException("Unsupported HTTP version", 505);

  const qIdx = rawTarget.indexOf("?");
  const rawPath = qIdx < 0 ? rawTarget : rawTarget.slice(0, qIdx);
  const path = safeDecode(rawPath);
  const query = parseQuery(qIdx < 0 ? "" : rawTarget.slice(qIdx + 1));

  const headers = new FieldCollection();
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === "") break;
    if (line.startsWith(" ") || line.startsWith("\t")) throw new HttpParseException("Obsolete line folding rejected");
    const c = line.indexOf(":");
    if (c <= 0) throw new HttpParseException("Malformed header field");
    const name = line.slice(0, c);
    if (!TOKEN.test(name)) throw new HttpParseException("Invalid header name");
    headers.set(name, line.slice(c + 1).trim());
    if (++count > limits.maxHeaderCount) throw new HttpParseException("Too many header fields", 431);
  }

  if (protocol === HttpProtocol.Http11 && !headers.has("Host")) {
    throw new HttpParseException("Missing Host header");
  }

  return { method, path, rawTarget, protocol, headers, query };
}

export function detectFraming(header: ParsedHeader): BodyFramingResult {
  const te = header.headers.get("Transfer-Encoding");
  const cl = header.headers.get("Content-Length");

  const hasChunked = te != null && te.split(",").some((t) => t.trim().toLowerCase() === "chunked");

  // Request smuggling: reject Transfer-Encoding + Content-Length together (RFC 9112 §6.1).
  if (hasChunked && cl != null) throw new HttpParseException("Both Transfer-Encoding and Content-Length present");

  if (hasChunked) return { framing: BodyFraming.Chunked, contentLength: 0 };

  if (cl != null) {
    if (!/^\d+$/.test(cl)) throw new HttpParseException("Invalid Content-Length value");
    const n = Number(cl);
    if (n > 0) return { framing: BodyFraming.ContentLength, contentLength: n };
  }

  return { framing: BodyFraming.None, contentLength: 0 };
}

function parseQuery(raw: string): FieldCollection {
  const query = new FieldCollection();
  if (raw.length === 0) return query;
  for (const pair of raw.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    query.set(safeDecode(key.replace(/\+/g, " ")), safeDecode(value.replace(/\+/g, " ")));
  }
  return query;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
