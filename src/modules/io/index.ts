/**
 * IO module: response content (string/bytes) and resources, plus `Content.from(...)` to mount
 * a resource as a handler.
 */
import {
  ContentType,
  type Handler,
  type HandlerBuilder,
  type Request,
  type Response,
  type ResponseContent,
  type ResponseWriter,
} from "../../api/index.ts";

const encoder = new TextEncoder();

export class StringContent implements ResponseContent {
  private readonly bytes: Uint8Array;
  readonly length: number;
  readonly type: ContentType;

  constructor(text: string, type: ContentType = ContentType.TextPlain) {
    this.bytes = encoder.encode(text);
    this.length = this.bytes.length;
    this.type = type;
  }

  write(writer: ResponseWriter): void {
    writer.write(this.bytes);
  }
}

export class ByteContent implements ResponseContent {
  readonly length: number;
  constructor(
    private readonly bytes: Uint8Array,
    readonly type: ContentType = ContentType.ApplicationOctetStream,
  ) {
    this.length = bytes.length;
  }
  write(writer: ResponseWriter): void {
    writer.write(this.bytes);
  }
}

export interface Resource {
  getContent(): ResponseContent;
}

export const Resource = {
  fromString(data: string, type: ContentType = ContentType.TextPlain): Resource {
    return { getContent: () => new StringContent(data, type) };
  },
};

class ContentHandler implements Handler {
  constructor(private readonly resource: Resource) {}
  async prepare(): Promise<void> {}
  async handle(request: Request): Promise<Response | null> {
    return request.respond().content(this.resource.getContent()).build();
  }
}

export const Content = {
  from(resource: Resource): HandlerBuilder {
    return { build: () => new ContentHandler(resource) };
  },
};
