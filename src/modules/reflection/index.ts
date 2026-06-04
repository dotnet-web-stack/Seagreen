/**
 * Reflection module: the runtime-invocation framework. Because TypeScript has no runtime type
 * reflection, routing and parameter sources are declared with decorators (+ reflect-metadata
 * for scalar param types). Parameter NAMES are erased, so every bound parameter carries its
 * name/source in its decorator. Absent optional arguments are passed as `undefined` so the
 * function's declared default applies (the CodeGreen optional-default lesson — free in JS).
 */
import "reflect-metadata";
import {
  ContentType,
  type Handler,
  ProviderException,
  type Request,
  type Response,
  type ResponseBuilder,
  ResponseStatus,
  type Server,
} from "../../api/index.ts";
import { convert, Json, JsonContent } from "../conversion/index.ts";
import { StringContent } from "../io/index.ts";

export type HttpVerb = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

type ParamSource = "path" | "query" | "body" | "content" | "stream" | "request";
interface ParamSpec {
  source: ParamSource;
  name: string;
}

interface RouteMeta {
  key: string;
  verbs: HttpVerb[];
  path: string;
}

const ROUTES = Symbol.for("seagreen:routes");
const PARAMS = Symbol.for("seagreen:params");

// ---------------------------------------------------------------------------- route registration

/** Used by @ResourceMethod (webservices) and @ControllerAction (controllers). */
export function registerRoute(prototype: object, key: string, verbs: HttpVerb[], path: string): void {
  const routes: RouteMeta[] = Reflect.getOwnMetadata(ROUTES, prototype) ?? [];
  routes.push({ key, verbs, path });
  Reflect.defineMetadata(ROUTES, routes, prototype);
}

function paramDecorator(source: ParamSource, name: string) {
  return (target: object, key: string | symbol, index: number): void => {
    const specs: ParamSpec[] = Reflect.getOwnMetadata(PARAMS, target, key) ?? [];
    specs[index] = { source, name };
    Reflect.defineMetadata(PARAMS, specs, target, key);
  };
}

export const FromPath = (name: string) => paramDecorator("path", name);
export const FromQuery = (name: string) => paramDecorator("query", name);
export const FromBody = () => paramDecorator("body", "");
export const FromContent = () => paramDecorator("content", "");
export const FromStream = () => paramDecorator("stream", "");
export const Inject = () => paramDecorator("request", "");

/** Names of the `@FromPath` parameters of a method, in declaration order (used by controllers). */
export function declaredPathParams(prototype: object, key: string): string[] {
  const specs: ParamSpec[] = Reflect.getOwnMetadata(PARAMS, prototype, key) ?? [];
  return specs.filter((s) => s && s.source === "path").map((s) => s.name);
}

// ---------------------------------------------------------------------------- result wrapper

/** Wraps a payload while still allowing the generated response to be tweaked (status, headers). */
export class Result<T> {
  private _status: ResponseStatus | null = null;
  private readonly _headers: [string, string][] = [];

  constructor(readonly payload: T) {}

  status(status: ResponseStatus): this {
    this._status = status;
    return this;
  }

  header(name: string, value: string): this {
    this._headers.push([name, value]);
    return this;
  }

  apply(builder: ResponseBuilder): void {
    if (this._status) builder.status(this._status);
    for (const [name, value] of this._headers) builder.header(name, value);
  }
}

// ---------------------------------------------------------------------------- operations

type Segment = { kind: "lit"; value: string } | { kind: "var"; name: string };

function parseSegments(path: string): Segment[] {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(":") ? { kind: "var", name: s.slice(1) } : { kind: "lit", value: s }));
}

function matchSegments(segments: Segment[], remaining: string[]): Record<string, string> | null {
  if (segments.length !== remaining.length) return null;
  const vars: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Segment;
    const value = remaining[i] as string;
    if (seg.kind === "lit") {
      if (seg.value !== value) return null;
    } else {
      vars[seg.name] = value;
    }
  }
  return vars;
}

interface Operation {
  verbs: HttpVerb[];
  segments: Segment[];
  key: string;
  params: ParamSpec[];
  paramTypes: unknown[];
  invoke: (...args: unknown[]) => unknown;
}

/** Reads decorator metadata off an instance and builds its operations. */
export function buildOperations(instance: object): Operation[] {
  const prototype = Object.getPrototypeOf(instance) as object;
  const routes: RouteMeta[] = Reflect.getOwnMetadata(ROUTES, prototype) ?? [];
  return routes.map((route) => {
    const params: ParamSpec[] = Reflect.getOwnMetadata(PARAMS, prototype, route.key) ?? [];
    const paramTypes: unknown[] = Reflect.getMetadata("design:paramtypes", prototype, route.key) ?? [];
    const method = (instance as Record<string, (...a: unknown[]) => unknown>)[route.key] as (...a: unknown[]) => unknown;
    return { verbs: route.verbs, segments: parseSegments(route.path), key: route.key, params, paramTypes, invoke: method.bind(instance) };
  });
}

function isResponse(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status instanceof ResponseStatus &&
    "headers" in value
  );
}

async function bindArgument(
  spec: ParamSpec | undefined,
  type: unknown,
  request: Request,
  pathVars: Record<string, string>,
  bodyText: () => Promise<string>,
): Promise<unknown> {
  if (!spec) return undefined;
  switch (spec.source) {
    case "path":
      return convert(pathVars[spec.name], type);
    case "query":
      return convert(request.header.query.get(spec.name), type);
    case "body": {
      const text = await bodyText();
      return convert(text.length === 0 ? undefined : text, type);
    }
    case "content": {
      const text = await bodyText();
      return text.length === 0 ? undefined : Json.deserialize(text);
    }
    case "stream":
      return request.getBody();
    case "request":
      return request;
  }
}

/** Routes a request to one of the operations and turns the result into a response. */
export class ServiceHandler implements Handler {
  constructor(private readonly operations: Operation[]) {}

  async prepare(): Promise<void> {}

  async handle(request: Request): Promise<Response | null> {
    const verb = request.header.method as HttpVerb;
    const remaining = request.header.target.remaining;

    for (const op of this.operations) {
      if (!op.verbs.includes(verb)) continue;
      const pathVars = matchSegments(op.segments, remaining);
      if (pathVars === null) continue;

      let cachedBody: string | undefined;
      const bodyText = async (): Promise<string> => {
        if (cachedBody === undefined) cachedBody = (await request.getBody()?.text()) ?? "";
        return cachedBody;
      };

      const args = await Promise.all(
        op.params.map((spec, i) => bindArgument(spec, op.paramTypes[i], request, pathVars, bodyText)),
      );

      let result: unknown;
      try {
        result = await op.invoke(...args);
      } catch (e) {
        if (e instanceof ProviderException) return applyProviderException(request, e);
        throw e;
      }
      return buildResponse(request, result);
    }

    return null; // no operation matched → 404
  }
}

function applyProviderException(request: Request, e: ProviderException): Response {
  const builder = request.respond().status(e.status);
  e.modifications?.(builder);
  return builder.content(new StringContent(e.message)).build();
}

function buildResponse(request: Request, result: unknown): Response {
  let modify: ((b: ResponseBuilder) => void) | null = null;
  let payload = result;

  if (result instanceof Result) {
    modify = (b) => result.apply(b);
    payload = result.payload;
  }

  const builder = request.respond();
  modify?.(builder);

  if (payload === undefined || payload === null) {
    return builder.status(ResponseStatus.NoContent).build();
  }
  if (isResponse(payload)) {
    return payload;
  }
  if (typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean") {
    return builder.content(new StringContent(String(payload), ContentType.TextPlain)).build();
  }
  return builder.content(new JsonContent(payload)).build();
}
