# Seagreen

Experimental GenHTTP port to Typescript — on the [Bun](https://bun.sh) runtime, the TypeScript
sibling of the Kotlin port (CodeGreen). It ports GenHTTP's own internal HTTP/1.1 engine, built on
`Bun.listen` raw TCP (not `Bun.serve`). Architecture, type mappings and roadmap: [PORTING.md](./PORTING.md).

## Requirements

[Bun](https://bun.sh) (≥ 1.3) — there is no separate build step; Bun runs the TypeScript directly:

```sh
curl -fsSL https://bun.sh/install | bash
```

## Running

```sh
bun install                        # install dependencies (once)

bun run playground                 # start the demo server on http://localhost:8080
#   PORT=9000 bun run playground   # …or choose the port
#   bun run src/playground/main.ts # …or run the entry file directly

# Bun is single-threaded per process, so one process uses one core (~160K req/s here).
# For all cores, run worker processes that share the port (SO_REUSEPORT):
WORKERS=$(nproc) bun run playground   # ~linear scaling across cores

bun test                           # run the acceptance suite (23 tests)
bun run typecheck                  # type-check with tsc --noEmit
```

## Try it

With the playground running (`bun run playground`):

```sh
curl  http://localhost:8080/pipeline                            # -> ok
curl "http://localhost:8080/baseline11?a=20&b=22"               # -> 42
curl -X POST "http://localhost:8080/baseline11?a=20&b=22" -d 8  # -> 50   (query + body)
curl "http://localhost:8080/json/3?m=10"                        # -> 3 items, totals ×10
curl -i "http://localhost:8080/crud/items/1"                    # note the X-Cache: MISS / HIT header
curl -X POST --data-binary @somefile http://localhost:8080/upload   # -> streamed byte count
```

## Embedding the engine

```ts
import { Host } from "./src/engine/internal/index.ts";
import { Layout } from "./src/modules/layouting/index.ts";
import { Content, Resource } from "./src/modules/io/index.ts";

const app = Layout.create().add("hello", Content.from(Resource.fromString("hi")));

await Host.create().handler(app).port(8080).run();   // serves http://localhost:8080/hello
```

Webservices use decorators (`@ResourceMethod`, `@FromQuery`, `@FromPath`, `@FromBody`, …) — see
`src/playground/services.ts` for worked examples.
