import { expect, test } from "bun:test";
import { ContentType, type Handler, type Request, type Response } from "../src/api/index.ts";
import { StringContent } from "../src/modules/io/index.ts";
import { TestHost } from "../src/testing/index.ts";

function handler(fn: (request: Request) => Promise<Response | null>): Handler {
  return { prepare: async () => {}, handle: fn };
}

test("serves content", async () => {
  const host = await TestHost.run(handler(async (r) => r.respond().content(new StringContent("Hello World!")).build()));
  try {
    const res = await host.request("/");
    expect(res.status).toBe(200);
    expect(res.body).toBe("Hello World!");
    expect(res.header("content-type")).toContain("text/plain");
  } finally {
    await host.close();
  }
});

test("exposes method and decoded path", async () => {
  const host = await TestHost.run(
    handler(async (r) => r.respond().content(new StringContent(`${r.header.method} ${r.header.path}`)).build()),
  );
  try {
    expect((await host.request("/api/items")).body).toBe("GET /api/items");
  } finally {
    await host.close();
  }
});

test("returns 404 when the handler returns null", async () => {
  const host = await TestHost.run(handler(async () => null));
  try {
    expect((await host.request("/missing")).status).toBe(404);
  } finally {
    await host.close();
  }
});

test("HEAD has no body", async () => {
  const host = await TestHost.run(handler(async (r) => r.respond().content(new StringContent("42")).build()));
  try {
    const res = await host.request("/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.header("content-length")).toBe("2");
    expect(res.body).toBe("");
  } finally {
    await host.close();
  }
});

test("rejects request smuggling with 400", async () => {
  const host = await TestHost.run(handler(async (r) => r.respond().content(new StringContent("ok")).build()));
  try {
    const raw = "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n";
    expect((await host.raw(raw)).status).toBe(400);
  } finally {
    await host.close();
  }
});

test("rejects missing Host with 400", async () => {
  const host = await TestHost.run(handler(async (r) => r.respond().content(new StringContent("ok")).build()));
  try {
    expect((await host.raw("GET / HTTP/1.1\r\nAccept: */*\r\n\r\n")).status).toBe(400);
  } finally {
    await host.close();
  }
});

test("streams a large request body", async () => {
  const size = 2 * 1024 * 1024; // > 1 MB memory limit → streamed
  const payload = "x".repeat(size);
  const host = await TestHost.run(
    handler(async (r) => {
      const bytes = await r.getBody()!.bytes();
      return r.respond().content(new StringContent(String(bytes.length))).build();
    }),
  );
  try {
    const res = await host.request("/upload", { method: "POST", body: payload });
    expect(res.status).toBe(200);
    expect(res.body).toBe(String(size));
  } finally {
    await host.close();
  }
});

test("drains a large body the handler ignores", async () => {
  const payload = "y".repeat(2 * 1024 * 1024);
  const host = await TestHost.run(handler(async (r) => r.respond().content(new StringContent("ok")).build()));
  try {
    const res = await host.request("/ignore", { method: "POST", body: payload });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  } finally {
    await host.close();
  }
});
