import { expect, test } from "bun:test";
import { createApp } from "../src/playground/project.ts";
import { TestHost } from "../src/testing/index.ts";

async function run() {
  return TestHost.run(createApp());
}

test("pipeline returns ok", async () => {
  const host = await run();
  try {
    expect((await host.request("/pipeline")).body).toBe("ok");
  } finally {
    await host.close();
  }
});

test("baseline sums query (GET) and query+body (POST)", async () => {
  const host = await run();
  try {
    expect((await host.request("/baseline11?a=20&b=22")).body).toBe("42");
    expect((await host.request("/baseline2?a=1&b=2")).body).toBe("3");
    expect((await host.request("/baseline11?a=20&b=22", { method: "POST", body: "8" })).body).toBe("50");
  } finally {
    await host.close();
  }
});

test("json processes items with the m default and override", async () => {
  const host = await run();
  try {
    const def = JSON.parse((await host.request("/json/3")).body);
    expect(def.count).toBe(3);
    expect(def.items.map((i: { total: number }) => i.total)).toEqual([10, 22, 36]); // m defaults to 1

    const scaled = JSON.parse((await host.request("/json/2?m=10")).body);
    expect(scaled.items.map((i: { total: number }) => i.total)).toEqual([100, 220]);
  } finally {
    await host.close();
  }
});

test("upload streams and counts a large body", async () => {
  const host = await run();
  try {
    const size = 2 * 1024 * 1024;
    const res = await host.request("/upload", { method: "POST", body: "z".repeat(size) });
    expect(res.body).toBe(String(size));
  } finally {
    await host.close();
  }
});

test("crud: list, cached read (X-Cache), create 201, update, 404", async () => {
  const host = await run();
  try {
    const list = JSON.parse((await host.request("/crud/items?category=electronics&limit=2")).body);
    expect(list.items.length).toBe(2);
    expect(list.page).toBe(1);

    const miss = await host.request("/crud/items/1");
    expect(miss.status).toBe(200);
    expect(miss.header("x-cache")).toBe("MISS");
    expect((await host.request("/crud/items/1")).header("x-cache")).toBe("HIT");

    expect((await host.request("/crud/items/999999")).status).toBe(404);

    const created = await host.request("/crud/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 5000, name: "Widget", category: "tools", price: 9, quantity: 3 }),
    });
    expect(created.status).toBe(201);

    const updated = await host.request("/crud/items/5000", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", price: 99, quantity: 7 }),
    });
    expect(updated.status).toBe(200);
    expect(JSON.parse(updated.body).price).toBe(99);
  } finally {
    await host.close();
  }
});
