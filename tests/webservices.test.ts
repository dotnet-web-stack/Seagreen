import { expect, test } from "bun:test";
import { ResponseStatus } from "../src/api/index.ts";
import { Layout } from "../src/modules/layouting/index.ts";
import { FromBody, FromContent, FromPath, FromQuery, ResourceMethod, Result, Service } from "../src/modules/webservices/index.ts";
import { TestHost } from "../src/testing/index.ts";

class Sum {
  constructor(
    readonly a: number,
    readonly b: number,
    readonly result: number,
  ) {}
}

class MathService {
  @ResourceMethod("GET", "add")
  add(@FromQuery("a") a: number, @FromQuery("b") b: number): Sum {
    return new Sum(a, b, a + b);
  }

  @ResourceMethod("POST", "add")
  addBody(@FromQuery("a") a: number, @FromQuery("b") b: number, @FromBody() c: number): number {
    return a + b + c;
  }

  @ResourceMethod("GET", "greet/:name")
  greet(@FromPath("name") name: string): string {
    return `Hello, ${name}!`;
  }

  // m has a default — must be honored when the query param is absent.
  @ResourceMethod("GET", "scale/:n")
  scale(@FromPath("n") n: number, @FromQuery("m") m = 3): number {
    return n * m;
  }

  @ResourceMethod("POST", "echo")
  echo(@FromContent() message: unknown): unknown {
    return message;
  }

  @ResourceMethod("POST", "create")
  create(@FromContent() item: { name: string }): Result<{ name: string }> {
    return new Result(item).status(ResponseStatus.Created);
  }
}

async function run() {
  return TestHost.run(Layout.create().add("api", Service.from(MathService)));
}

test("binds query params and serializes the result as JSON", async () => {
  const host = await run();
  try {
    const res = await host.request("/api/add?a=20&b=22");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ a: 20, b: 22, result: 42 });
  } finally {
    await host.close();
  }
});

test("POST overload sums query + body", async () => {
  const host = await run();
  try {
    const res = await host.request("/api/add?a=20&b=22", { method: "POST", body: "8" });
    expect(res.body).toBe("50");
  } finally {
    await host.close();
  }
});

test("binds a path variable", async () => {
  const host = await run();
  try {
    expect((await host.request("/api/greet/Seagreen")).body).toBe("Hello, Seagreen!");
  } finally {
    await host.close();
  }
});

test("honors an optional parameter default when the query value is absent", async () => {
  const host = await run();
  try {
    expect((await host.request("/api/scale/4")).body).toBe("12"); // m defaults to 3
    expect((await host.request("/api/scale/4?m=10")).body).toBe("40");
  } finally {
    await host.close();
  }
});

test("deserializes a JSON body and echoes it", async () => {
  const host = await run();
  try {
    const res = await host.request("/api/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", priority: 5 }),
    });
    expect(JSON.parse(res.body)).toEqual({ text: "hi", priority: 5 });
  } finally {
    await host.close();
  }
});

test("Result wrapper sets the status", async () => {
  const host = await run();
  try {
    const res = await host.request("/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Widget" }),
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ name: "Widget" });
  } finally {
    await host.close();
  }
});
