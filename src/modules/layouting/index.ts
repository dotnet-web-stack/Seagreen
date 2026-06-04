/**
 * Layouting module: a routing handler that maps the next path segment to a child handler,
 * with an optional index handler at the segment's end. Mirrors GenHTTP's Layout.
 */
import type {
  Concern,
  ConcernBuilder,
  Handler,
  HandlerBuilder,
  Request,
  Response,
  TypedHandlerBuilder,
} from "../../api/index.ts";

function toHandler(handler: Handler | HandlerBuilder): Handler {
  return "handle" in handler ? handler : handler.build();
}

class LayoutHandler implements Handler {
  constructor(
    private readonly routes: Map<string, Handler>,
    private readonly indexHandler: Handler | null,
  ) {}

  async prepare(): Promise<void> {
    for (const handler of this.routes.values()) await handler.prepare();
    await this.indexHandler?.prepare();
  }

  async handle(request: Request): Promise<Response | null> {
    const target = request.header.target;
    if (target.isLast) {
      return this.indexHandler ? this.indexHandler.handle(request) : null;
    }
    const segment = target.current as string;
    const route = this.routes.get(segment);
    if (!route) return null;
    target.advance();
    return route.handle(request);
  }
}

export class LayoutBuilder implements TypedHandlerBuilder<LayoutBuilder> {
  private readonly routes = new Map<string, Handler>();
  private indexHandler: Handler | null = null;
  private readonly concerns: ConcernBuilder[] = [];

  add(concern: ConcernBuilder): LayoutBuilder;
  add(name: string, handler: Handler | HandlerBuilder): LayoutBuilder;
  add(a: ConcernBuilder | string, b?: Handler | HandlerBuilder): LayoutBuilder {
    if (typeof a === "string") {
      this.routes.set(a, toHandler(b as Handler | HandlerBuilder));
    } else {
      this.concerns.push(a);
    }
    return this;
  }

  index(handler: Handler | HandlerBuilder): LayoutBuilder {
    this.indexHandler = toHandler(handler);
    return this;
  }

  build(): Handler {
    let handler: Handler = new LayoutHandler(this.routes, this.indexHandler);
    for (let i = this.concerns.length - 1; i >= 0; i--) {
      handler = (this.concerns[i] as ConcernBuilder).build(handler) as Concern;
    }
    return handler;
  }
}

export const Layout = {
  create(): LayoutBuilder {
    return new LayoutBuilder();
  },
};
