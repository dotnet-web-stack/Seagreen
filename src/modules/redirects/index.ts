/**
 * Redirects module: `Redirect.to(location, temporary?)`. Method-aware status, matching GenHTTP:
 * temporary → 307 (GET) / 303 (POST); permanent → 301 (GET) / 308 (POST).
 */
import { type Handler, type HandlerBuilder, type Request, type Response, ResponseStatus } from "../../api/index.ts";

class RedirectHandler implements Handler {
  constructor(
    private readonly location: string,
    private readonly temporary: boolean,
  ) {}

  async prepare(): Promise<void> {}

  async handle(request: Request): Promise<Response> {
    const isPost = request.header.method === "POST";
    const status = this.temporary
      ? isPost
        ? ResponseStatus.SeeOther // 303
        : ResponseStatus.TemporaryRedirect // 307
      : isPost
        ? ResponseStatus.PermanentRedirect // 308
        : ResponseStatus.MovedPermanently; // 301
    return request.respond().status(status).header("Location", this.location).build();
  }
}

export const Redirect = {
  to(location: string, temporary = false): HandlerBuilder {
    return { build: () => new RedirectHandler(location, temporary) };
  },
};
