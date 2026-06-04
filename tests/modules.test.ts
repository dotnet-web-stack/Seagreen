import { expect, test } from "bun:test";
import { type Handler, type Request, type Response } from "../src/api/index.ts";
import { BasicAuthentication, getUser } from "../src/modules/authentication/index.ts";
import { ControllerAction, Controller, FromPath } from "../src/modules/controllers/index.ts";
import { StringContent } from "../src/modules/io/index.ts";
import { Layout } from "../src/modules/layouting/index.ts";
import { Redirect } from "../src/modules/redirects/index.ts";
import { TestHost } from "../src/testing/index.ts";

// ---------------------------------------------------------------------------- redirects

async function redirectStatus(temporary: boolean, method: string): Promise<{ status: number; location: string | undefined }> {
  const host = await TestHost.run(Layout.create().add("r", Redirect.to("https://example.org/", temporary)));
  try {
    const res = await host.raw(`${method} /r HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    return { status: res.status, location: res.header("location") };
  } finally {
    await host.close();
  }
}

test("temporary redirect: 307 GET / 303 POST", async () => {
  expect((await redirectStatus(true, "GET")).status).toBe(307);
  expect((await redirectStatus(true, "POST")).status).toBe(303);
});

test("permanent redirect: 301 GET / 308 POST, with Location", async () => {
  const get = await redirectStatus(false, "GET");
  expect(get.status).toBe(301);
  expect(get.location).toBe("https://example.org/");
  expect((await redirectStatus(false, "POST")).status).toBe(308);
});

// ---------------------------------------------------------------------------- controllers

class TestController {
  @ControllerAction()
  index(): string {
    return "index";
  }

  @ControllerAction()
  action(): string {
    return "action";
  }

  @ControllerAction(["GET"])
  details(@FromPath("id") id: number): string {
    return `id=${id}`;
  }
}

test("controller routes by action name + path params", async () => {
  const host = await TestHost.run(Layout.create().add("t", Controller.from(TestController)));
  try {
    expect((await host.request("/t")).body).toBe("index");
    expect((await host.request("/t/action")).body).toBe("action");
    expect((await host.request("/t/details/5")).body).toBe("id=5");
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------- authentication

const userHandler: Handler = {
  prepare: async () => {},
  handle: async (request: Request): Promise<Response> =>
    request.respond().content(new StringContent(getUser(request)?.displayName ?? "none")).build(),
};

test("basic auth: 401 without credentials, 200 with valid credentials", async () => {
  const app = Layout.create().index(userHandler).add(BasicAuthentication.create().add("user", "pass"));
  const host = await TestHost.run(app);
  try {
    expect((await host.request("/")).status).toBe(401);

    const ok = await host.request("/", { headers: { Authorization: `Basic ${btoa("user:pass")}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("user");

    expect((await host.request("/", { headers: { Authorization: `Basic ${btoa("user:wrong")}` } })).status).toBe(401);
  } finally {
    await host.close();
  }
});
