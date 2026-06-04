/**
 * Conversion module: scalar formatters (string ↔ value) and JSON (de)serialization.
 *
 * Note vs CodeGreen: JSON is structural in JS, so serialization needs no type info — the
 * generic-serializer ("star projection") problem cannot occur — and `JSON.parse` ignores
 * unknown keys by default, matching System.Text.Json. Deserialization validation (when a
 * schema is supplied) goes through the schema (e.g. zod).
 */
import { ContentType, type ResponseContent, type ResponseWriter } from "../../api/index.ts";

const encoder = new TextEncoder();

/** True if `type` is a scalar the formatters can read from a string. */
export function canFormat(type: unknown): boolean {
  return type === Number || type === Boolean || type === String;
}

/**
 * Converts a raw query/path/body string to the target scalar type. An absent value yields
 * `undefined`, so an optional function parameter keeps its declared default (the CodeGreen
 * optional-default lesson — natural in JS).
 */
export function convert(raw: string | undefined, type: unknown): unknown {
  if (raw === undefined) return undefined;
  if (type === Number) return raw === "" ? 0 : Number(raw);
  if (type === Boolean) return raw === "true" || raw === "1";
  return raw; // String / default
}

export interface Schema<T> {
  parse(value: unknown): T;
}

export const Json = {
  serialize(value: unknown): string {
    return JSON.stringify(value);
  },
  deserialize<T>(text: string, schema?: Schema<T>): T {
    const value = JSON.parse(text) as unknown;
    return schema ? schema.parse(value) : (value as T);
  },
};

/** A JSON response body for a serialized value. */
export class JsonContent implements ResponseContent {
  private readonly bytes: Uint8Array;
  readonly length: number;
  readonly type = ContentType.ApplicationJson;

  constructor(value: unknown) {
    this.bytes = encoder.encode(JSON.stringify(value));
    this.length = this.bytes.length;
  }

  write(writer: ResponseWriter): void {
    writer.write(this.bytes);
  }
}
