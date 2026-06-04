/**
 * In-memory data layer for the playground (dataset + store + a 200 ms TTL cache), standing in
 * for the JSON file + Postgres the HttpArena entry would use — so the demo runs dependency-free.
 */
import type { CrudItem, DatasetItem, ProcessedItem } from "./model.ts";

const CATEGORIES = ["electronics", "books", "toys", "garden", "sports"];

class TtlCache {
  private readonly entries = new Map<number, { body: string; expiresAt: number }>();
  constructor(private readonly ttlMs = 200) {}

  get(id: number): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= performance.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.body;
  }
  set(id: number, body: string): void {
    this.entries.set(id, { body, expiresAt: performance.now() + this.ttlMs });
  }
  invalidate(id: number): void {
    this.entries.delete(id);
  }
}

export const Data = {
  dataset: buildDataset(1000),
  store: new Map<number, DatasetItem>(),
  cache: new TtlCache(200),
  nextId: 1001,

  byCategory(category: string, limit: number, offset: number): ProcessedItem[] {
    return [...this.store.values()]
      .filter((i) => i.category === category)
      .sort((a, b) => a.id - b.id)
      .slice(offset, offset + limit)
      .map(toProcessed);
  },

  findById(id: number): ProcessedItem | undefined {
    const item = this.store.get(id);
    return item ? toProcessed(item) : undefined;
  },

  upsert(item: CrudItem): ProcessedItem {
    const id = item.id ?? this.nextId++;
    const stored: DatasetItem = {
      id,
      name: item.name ?? "New Product",
      category: item.category ?? "test",
      price: item.price,
      quantity: item.quantity,
      active: true,
      tags: ["bench"],
      rating: { score: 0, count: 0 },
    };
    this.store.set(id, stored);
    return toProcessed(stored);
  },

  update(id: number, item: CrudItem): ProcessedItem | undefined {
    const existing = this.store.get(id);
    if (!existing) return undefined;
    existing.name = item.name ?? existing.name;
    existing.price = item.price;
    existing.quantity = item.quantity;
    return toProcessed(existing);
  },
};

for (const item of Data.dataset) Data.store.set(item.id, item);

function toProcessed(item: DatasetItem): ProcessedItem {
  return { ...item, total: 0 };
}

function buildDataset(n: number): DatasetItem[] {
  return Array.from({ length: n }, (_, i) => {
    const id = i + 1;
    const category = CATEGORIES[i % CATEGORIES.length] as string;
    return {
      id,
      name: `Item ${id}`,
      category,
      price: 10 + (i % 90),
      quantity: 1 + (i % 20),
      active: i % 2 === 0,
      tags: ["bench", category],
      rating: { score: (i % 5) + 1, count: i % 100 },
    };
  });
}
