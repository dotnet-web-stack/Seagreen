/**
 * Playground webservices, mirroring the HttpArena `genhttp-11` / `fishcake` entries.
 */
import {
  ContentType,
  ProviderException,
  type Request,
  type RequestBody,
  type Response,
  ResponseStatus,
} from "../api/index.ts";
import { StringContent } from "../modules/io/index.ts";
import {
  FromBody,
  FromContent,
  FromPath,
  FromQuery,
  FromStream,
  Inject,
  ResourceMethod,
  Result,
} from "../modules/webservices/index.ts";
import { Data } from "./data.ts";
import { type CrudItem, ListWithCount, type ProcessedItem } from "./model.ts";

/** `GET/POST /baselineXX` — sum query values (POST adds a body value). */
export class Baseline {
  @ResourceMethod("GET")
  sum(@FromQuery("a") a: number, @FromQuery("b") b: number): number {
    return a + b;
  }

  @ResourceMethod("POST")
  sumBody(@FromQuery("a") a: number, @FromQuery("b") b: number, @FromBody() c: number): number {
    return a + b + c;
  }
}

/** `POST /upload` — streams the body and returns the byte count. */
export class Upload {
  @ResourceMethod("POST")
  async compute(@FromStream() body: RequestBody): Promise<number> {
    let total = 0;
    for await (const chunk of body.chunks()) total += chunk.length;
    return total;
  }
}

/** `GET /json/:count?m=` — process the first `count` items; `m` scales the total (default 1). */
export class JsonService {
  @ResourceMethod("GET", ":count")
  compute(@FromPath("count") count: number, @FromQuery("m") m = 1): ListWithCount<ProcessedItem> {
    const take = Math.max(0, Math.min(count, Data.dataset.length));
    const items = Data.dataset.slice(0, take).map((d) => ({ ...d, total: d.price * d.quantity * m }));
    return new ListWithCount(items);
  }
}

/** `/crud/items` — list, cached read (X-Cache), upsert create, update. */
export class Crud {
  @ResourceMethod("GET")
  list(@FromQuery("category") category = "electronics", @FromQuery("page") page = 1, @FromQuery("limit") limit = 10) {
    const p = Math.max(1, page);
    const l = Math.min(50, Math.max(1, limit));
    const items = Data.byCategory(category, l, (p - 1) * l);
    return { items, total: items.length, page: p, limit: l };
  }

  @ResourceMethod("GET", ":id")
  get(@FromPath("id") id: number, @Inject() request: Request): Response {
    const cached = Data.cache.get(id);
    if (cached !== undefined) {
      return request.respond().content(new StringContent(cached, ContentType.ApplicationJson)).header("X-Cache", "HIT").build();
    }
    const item = Data.findById(id);
    if (!item) throw new ProviderException(ResponseStatus.NotFound, `Item with ID ${id} does not exist`);
    const json = JSON.stringify(item);
    Data.cache.set(id, json);
    return request.respond().content(new StringContent(json, ContentType.ApplicationJson)).header("X-Cache", "MISS").build();
  }

  @ResourceMethod("POST")
  create(@FromContent() item: CrudItem): Result<ProcessedItem> {
    const created = Data.upsert(item);
    Data.cache.invalidate(created.id);
    return new Result(created).status(ResponseStatus.Created);
  }

  @ResourceMethod("PUT", ":id")
  update(@FromPath("id") id: number, @FromContent() item: CrudItem): ProcessedItem {
    const updated = Data.update(id, item);
    if (!updated) throw new ProviderException(ResponseStatus.NotFound, `Item with ID ${id} does not exist`);
    Data.cache.invalidate(id);
    return updated;
  }
}
