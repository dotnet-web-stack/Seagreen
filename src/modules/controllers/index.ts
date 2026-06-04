/**
 * Controllers module: `@ControllerAction` maps a method to a route by its (hyphenated) name —
 * `index` is the root — with `@FromPath` parameters appended as path segments. Reuses the
 * reflection invocation engine.
 */
import type { HandlerBuilder } from "../../api/index.ts";
import { buildOperations, declaredPathParams, type HttpVerb, registerRoute, ServiceHandler } from "../reflection/index.ts";

function hyphenate(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function ControllerAction(verbs: HttpVerb[] = ["GET"]) {
  return (target: object, key: string | symbol): void => {
    const name = String(key);
    const base = name === "index" ? "" : hyphenate(name);
    const path = [base, ...declaredPathParams(target, name).map((p) => `:${p}`)].filter((s) => s.length > 0).join("/");
    registerRoute(target, name, verbs, path);
  };
}

export const Controller = {
  from(controller: object | (new () => object)): HandlerBuilder {
    const instance = typeof controller === "function" ? new (controller as new () => object)() : controller;
    return { build: () => new ServiceHandler(buildOperations(instance)) };
  },
};

export { FromBody, FromContent, FromPath, FromQuery, Inject, Result } from "../reflection/index.ts";
