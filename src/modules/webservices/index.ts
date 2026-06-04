/**
 * Webservices module: the `@ResourceMethod` decorator and service mounting. A service is a
 * plain class whose decorated methods become routed operations.
 */
import type { HandlerBuilder } from "../../api/index.ts";
import { buildOperations, type HttpVerb, registerRoute, ServiceHandler } from "../reflection/index.ts";

/** Marks a method as a webservice operation. `path` may contain `:name` path variables. */
export function ResourceMethod(method: HttpVerb = "GET", path = "") {
  return (target: object, key: string | symbol): void => {
    registerRoute(target, key as string, [method], path);
  };
}

export const Service = {
  /** Builds a handler from a service instance or a no-arg service class. */
  from(service: object | (new () => object)): HandlerBuilder {
    const instance = typeof service === "function" ? new (service as new () => object)() : service;
    return { build: () => new ServiceHandler(buildOperations(instance)) };
  },
};

// Re-export the parameter decorators so services import them from one place.
export { FromBody, FromContent, FromPath, FromQuery, FromStream, Inject, Result } from "../reflection/index.ts";
