# Porting GenHTTP to TypeScript — codename **Seagreen**

A working plan for a 1:1 functional port of the C# [GenHTTP](https://github.com/Kaliumhexacyanoferrat/GenHTTP)
web server to TypeScript, written from the experience of doing the same port to Kotlin
(**CodeGreen**). The target for this first milestone is **the exact stage CodeGreen is at
today** (enumerated in §7).

> _Seagreen_ is a placeholder codename — rename at will.

---

## 0. Mandate (inherited from the CodeGreen port)

The GenHTTP maintainer's rules for a faithful port (issue #3) carry over verbatim:

- **1:1 functional port.** Don't skip or simplify concepts; keep concept names.
- **Same project structure** — public API at the package root, implementation in sub-packages.
- **Internal engine only** — port GenHTTP's own HTTP/1.1 engine; do **not** wrap a platform
  HTTP server (no `Bun.serve`, no `node:http`). The engine *is* one of the things being ported.
- **Copy acceptance tests 1:1** (originals must exist; you may add more).
- **Ignore the code-generation path** in Reflection — runtime invocation only.
- State-of-the-art idiomatic TypeScript, the way CodeGreen used state-of-the-art Kotlin.

---

## 1. Runtime & tooling — recommendation: **Bun**

**Use Bun**, for four reasons that matter to this specific project:

1. **Native TypeScript** — runs `.ts` directly, no build step. Keeps the edit/test loop as
   tight as Kotlin's, and avoids a transpile pipeline in the Docker image.
2. **Raw TCP via `Bun.listen`** — the faithful analogue of CodeGreen's Netty layer. We get
   `open` / `data(socket, Buffer)` / `close` callbacks (a push model, exactly like Netty's
   `channelRead`), which is what we need to drive our **own** parser and protocol handling.
3. **Fast startup + throughput** — this port will also become an HttpArena entry (a Bun
   sibling of `fishcake`), so cold start and RPS matter.
4. **Batteries included** — `bun test` (Jest-like), `bun` workspaces (monorepo), bundler.

**Critical:** build the engine on **`Bun.listen` (TCP)**, not `Bun.serve`. `Bun.serve` does
its own HTTP parsing and would bypass the Glyph11 parser + protocol engine we are porting.

**Alternatives** (if Bun is ruled out):
- **Node** — `node:net` for TCP; mature; but needs `tsx`/`tsdown` (or `--experimental-strip-types`)
  and has slower startup. Everything below still applies; swap `Bun.listen` → `net.createServer`
  and `bun test` → `node --test`/vitest.
- **Deno** — native TS, `Deno.listen` for TCP; fine, smaller ecosystem for this.

**Multi-core.** Bun's JS runs on a single thread (one event loop), like Node. **Plan for
multi-core from day one** (see lesson §9.2): run N processes (one per core) over a shared
socket with `Bun.listen({ reusePort: true })`, or `Worker` threads. CodeGreen got bitten by
accidentally collapsing to one event loop — don't repeat it.

**Toolchain:**

| Concern | Choice |
|---|---|
| Language | TypeScript, `strict: true` |
| Decorator metadata | `reflect-metadata` + `experimentalDecorators` + `emitDecoratorMetadata` (legacy decorators — see §6) |
| DTO schemas/validation | `zod` (or `typebox`) — needed because TS has no runtime types (§6) |
| Tests | `bun test` |
| Lint/format | Biome (single fast tool) |
| Package layout | Bun workspaces (monorepo) |

---

## 2. Project structure (mirrors GenHTTP / CodeGreen)

A Bun-workspaces monorepo, one package per GenHTTP project:

```
packages/
  api/            # public contracts: Request, Response, Handler, RequestBody, MemoryView…
  glyph11/        # hardened HTTP/1.1 header parser + body-framing detection (over Uint8Array)
  engine/
    shared/       # engine-agnostic types & configuration
    internal/     # the TCP/Bun engine: connection, decoder, dispatch, response writer
  modules/
    io/           # resources, content providers, string/stream content
    layouting/    # Layout router
    redirects/    # Redirect
    authentication/  # Basic auth concern
    conversion/   # formatters + JSON/form serialization
    reflection/   # operations, routing, injectors, result, interceptors (runtime invocation)
    functional/   # Inline (function-based endpoints)
    webservices/  # @ResourceMethod services
    controllers/  # @ControllerAction controllers
  testing/        # acceptance suites + TestHost (raw-TCP client)
  playground/     # runnable demo (HttpArena-shaped, like fishcake)
```

Keep public API at each package root and implementation under sub-folders (`provider/`,
`operations/`, `routing/`…), matching GenHTTP's folder names so the two trees stay diffable.

---

## 3. Type & idiom mapping (C# / Kotlin → TypeScript)

The cheat-sheet that drove CodeGreen, re-targeted to TS:

| GenHTTP (C#) | CodeGreen (Kotlin) | Seagreen (TypeScript) |
|---|---|---|
| `ReadOnlyMemory<byte>` | `MemoryView` | **`Uint8Array`** (+ `.subarray()` for zero-copy slices) |
| `Stream` / `Stream` in/out | `InputStream` / `OutputStream` | **`ReadableStream` / `WritableStream`** (or async iterables) |
| `ValueTask` / `Task` / `async` | `suspend` | **`async` / `Promise`** — the cleanest mapping; TS `async` *is* GenHTTP's `suspend` |
| `MethodInfo` + `Delegate` | `KFunction` | **plain function** + decorator metadata |
| attributes (`[ResourceMethod]`) | annotations | **decorators** (`@ResourceMethod`) |
| `record` / POCO | `data class` | `class` or `interface`/`type` |
| sealed hierarchy | sealed class | **discriminated union** (`{ kind: '…' }`) |
| `enum` | `enum` | `enum` or union of string literals |
| `Guid` | `java.util.UUID` | `string` (`crypto.randomUUID()`) |
| `DateTime` | `Instant` | `Date` (or `Temporal` when stable) |
| `DateOnly` | `LocalDate` | ISO `string` (or `Date`) |
| `T?` nullable | `T?` | `T | null | undefined` (prefer one; `strictNullChecks`) |
| `IBufferWriter<byte>` | `sink.stream` | `WritableStream` / `socket.write(Uint8Array)` |
| `ConcurrentDictionary` | `ConcurrentHashMap` | `Map` (per-worker; JS is single-threaded — no locks needed) |
| generics | generics | TS generics (structural) |

---

## 4. The engine (`engine/internal`) — the core

Mirror CodeGreen's `ThreadedServer` + `Glyph11RequestDecoder` + `HttpDispatchHandler`, on Bun TCP.

- **Listener:** `Bun.listen({ hostname:'0.0.0.0', port:8080, reusePort:true, socket:{ open, data, close, error } })`.
  Default bind `0.0.0.0:8080` (CodeGreen lesson — don't bind loopback).
- **Per-connection decoder:** accumulate incoming `Uint8Array`s, find the `\r\n\r\n` header
  terminator, run the Glyph11 parser over the header bytes, then detect body framing.
- **Body — stream it, never buffer it (lesson §9.1).** Expose the request body as a
  `ReadableStream`/async iterable fed by the `data` callback:
  - `Content-Length`: a length-limited stream (the analogue of GenHTTP's `LengthLimitedStream`).
  - `chunked`: a chunked-decoding stream.
  - **Backpressure:** `socket.pause()` when the consumer is behind, `socket.resume()` as it
    drains — the natural equivalent of CodeGreen's `autoRead` toggling. (JS async iterators make
    this *easier* than the Kotlin/Netty version — lean into it.)
  - **Drain** unread bodies after the handler so keep-alive connections stay clean (GenHTTP's
    `DrainAsync`).
- **Dispatch:** `await handler.handle(request)`; responses written in request order
  (keep-alive + pipelining). One in-flight request per connection at a time.
- **Response writer:** content-length and chunked sinks; `Date`/`Server` headers.
- **Hardening lives in Glyph11** (limits, smuggling rejection) — see §5.

Because everything is `async`, the "handler coroutine" concern from CodeGreen (handlers
running on the event-loop thread) largely disappears — but the **single event loop** is exactly
why multi-core (§9.2) must be designed in, not bolted on.

---

## 5. Glyph11 (parser) port

Port the hardened HTTP/1.1 **header** parser to operate over `Uint8Array`:

- Zero-copy field slices via `subarray` (method, path, version, header name/value spans) — the
  `MemoryView` idea maps straight onto `Uint8Array` views.
- **Body-framing detection only** (this is all Glyph11 does — it does *not* decode bodies; the
  engine does): inspect headers → `NONE` / `CONTENT_LENGTH=n` / `CHUNKED`. Chunked beats
  Content-Length (RFC 9112 §6.1); reject both-present as smuggling (400).
- Same hardening + `ParserLimits` (max header bytes, count, line length…); throw a typed
  `HttpParseException(status)` → the engine renders the 4xx.

---

## 6. Conversion / Reflection / Webservices / Controllers — the one genuinely hard part

**TypeScript has no runtime type reflection** (no `kotlin-reflect`, no `System.Reflection`).
This is *the* architectural difference from both prior ports, and it drives the whole
service stack. Strategy:

- **Routing + parameter sources via decorators**, not reflection of names:
  - Method decorators: `@ResourceMethod(method, path)`, `@ControllerAction(...methods)`.
  - Parameter decorators: `@FromBody`, `@FromPath('id')`, `@Query('a')`, `@Inject` — these
    record each parameter's *source* and *name* into `reflect-metadata`.
- **Parameter names erase** in JS (same problem as Kotlin's anonymous-lambda erasure, which
  forced CodeGreen onto function references). **Do not** parse `fn.toString()`. Declare every
  bound parameter with a decorator (or, for `functional`/`Inline`, a small builder that names
  args explicitly).
- **`emitDecoratorMetadata`** gives `design:paramtypes` — but only as constructors
  (`String`, `Number`, `Boolean`, or a class). Enough to pick a formatter for scalars; **not**
  enough to deserialize a DTO shape.
- **DTO (de)serialization:**
  - **Serialization is free** — `JSON.stringify` is structural, needs no type info. Two CodeGreen
    bugs simply *cannot occur* here: generic serialization (the `ListWithCount<T>` "star
    projection" failure) is a non-issue, and unknown-key leniency is the JS default (objects are
    structural), matching `System.Text.Json`.
  - **Deserialization/validation needs a schema.** Recommend a **`zod` schema per DTO** registered
    with the conversion module (or classes + `class-transformer`). The `@FromBody` decorator
    references the schema; the body stream is parsed + validated against it.
- **Optional parameter defaults (lesson §9.3):** JS honours defaults when an argument is omitted
  *positionally*. Build the call as a positional args array from the decorator-declared param
  list; for an **absent optional** param, leave a hole so the function default applies; for an
  absent **required** scalar, fall back to the formatter default (`0`/`false`/…). This reproduces
  CodeGreen's `ArgumentProvider`/`MethodHandler` fix.
- **Formatters** (string, bool, enum, UUID, date, primitive) ↔ `string`, as in Conversion.
- **`Result<T>`**, **`ProviderException(status)`**, **interceptors**, **injectors**
  (Request/Handler/User) — direct class ports; no reflection needed beyond the decorator metadata.

---

## 7. The checkpoint — "the same stage as CodeGreen" (definition of done for milestone 1)

Port until Seagreen matches CodeGreen's current surface:

| Package | Must include |
|---|---|
| `api` | Request/Response/Handler/RequestBody/MemoryView(=Uint8Array)/ContentType/headers/ServerHost builder |
| `glyph11` | hardened header parser + body-framing detector + limits |
| `engine/internal` | Bun-TCP engine, **streaming request bodies**, keep-alive, pipelining, chunked + content-length, **multi-core (reusePort/workers)**, default bind `0.0.0.0:8080` |
| `modules/io` | `Resource.fromString`, `Content.from`, string/stream content |
| `modules/layouting` | `Layout` router (`add`, `index`, `addSegment`) |
| `modules/redirects` | `Redirect.to` (301/302/307/308) |
| `modules/authentication` | Basic auth concern + known-users + `getUser` |
| `modules/conversion` | formatters + JSON (lenient unknown keys) + form (de)serialization |
| `modules/reflection` | operations, routing segments, injectors, `Result`, `ProviderException`, interceptors, **optional-default honoring** |
| `modules/functional` | `Inline` (function endpoints) |
| `modules/webservices` | `@ResourceMethod` services + `addService` |
| `modules/controllers` | `@ControllerAction` controllers + `addController` |
| `testing` | `TestHost` (raw-TCP client) + the acceptance suites **ported 1:1** (~**187** tests today) |
| `playground` | runnable HttpArena-shaped demo (pipeline/baseline/json/upload/async-db/crud) |

**Baked-in from the start** (don't "add later"): streaming bodies, multi-core, optional-default
honoring, structural JSON.

---

## 8. Migration order (vertical, test-driven)

The order CodeGreen proved out — bottom-up, but **vertically** through the service stack
because the acceptance tests only go green once a whole vertical exists:

```
api → glyph11 → engine/shared → engine/internal
    → io → layouting → (redirects, authentication)
    → conversion + reflection + functional   (together — Inline tests exercise all three)
    → webservices → controllers
    → testing (port suites alongside each layer) → playground
```

Port the matching acceptance suite **with** each layer. Expect the Conversion/Reflection/
Functional suites to stay red until the trio is complete (this surprised us once already).

---

## 9. Lessons from CodeGreen — design these in on day one

1. **Stream request bodies; never buffer them.** CodeGreen first buffered each body into one big
   array → 20 MB uploads blew memory to ~18 GiB and tanked throughput. Make the engine body a
   stream with backpressure from the very first commit. (JS makes this *easier* than Netty.)
2. **Multi-core from day one.** One event loop = one core. Use `reusePort` + N workers; verify CPU
   actually scales. (CodeGreen shipped a flag that pinned it to one core — caught only at benchmark.)
3. **Honor optional parameter defaults.** Don't force every absent query/body arg to `0` —
   reproduce the "omit absent optional, default absent required scalar" rule.
4. **JSON is structural here — two whole bug classes vanish.** No generic-serializer resolution,
   no unknown-key strictness. (System.Text.Json is lenient; so is `JSON.parse`.)
5. **Parameter names erase** — use parameter decorators, never `toString()` parsing.
6. **No runtime types** — decorators + `reflect-metadata` for routing/scalars, `zod` schemas for DTOs.
7. **Zero-copy with `Uint8Array.subarray`** — the `MemoryView` idea, for free.
8. **`async` is `suspend`** — the single async mechanism; don't invent a second one.

---

## 10. After the checkpoint: an HttpArena entry (the Bun `fishcake`)

Once milestone 1 is green, add an HttpArena entry mirroring `fishcake`:
- Bun TCP engine + the webservice stack; `postgres` (postgres.js) for `async-db`/`crud`;
  `dataset.json` for `/json`; in-process TTL cache for the cached read.
- Dockerfile on `oven/bun`; `EXPOSE 8080`; `reusePort` workers across cores.
- Declare the same supported test subset fishcake does (baseline/pipelined/limited-conn/json/
  upload/async-db/crud/api-4/api-16); omit TLS/HTTP-2/compression/static/websocket until those
  modules are ported.

---

## 11. Open decisions

- **Decorator flavour:** the reflection stack needs **legacy** decorators (`experimentalDecorators`
  + `emitDecoratorMetadata`) for `design:paramtypes`. TC39 Stage-3 decorators don't emit param
  types — if you adopt them, parameter typing must come entirely from `zod`/explicit specs.
- **DTO library:** `zod` (ergonomic, ubiquitous) vs `typebox` (JSON-Schema-native, faster). Pick one.
- **Per-worker state:** the CRUD cache and any DB pool are per-worker under `reusePort`; decide
  whether that's acceptable (it is for the benchmark) or whether a shared store is needed.
