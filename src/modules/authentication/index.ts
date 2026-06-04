/**
 * Authentication module: HTTP Basic auth as a concern (wraps a handler, 401s unauthenticated
 * requests, stashes the user for handlers to read via `getUser`).
 */
import {
  type Concern,
  type ConcernBuilder,
  type Handler,
  type Request,
  type Response,
  ResponseStatus,
} from "../../api/index.ts";

const USER_KEY = "__AUTH_USER";

export interface User {
  readonly displayName: string;
}

export class BasicUser implements User {
  constructor(readonly displayName: string) {}
}

export type Authenticator = (user: string, password: string) => User | null | Promise<User | null>;

class BasicAuthConcern implements Concern {
  constructor(
    readonly content: Handler,
    private readonly realm: string,
    private readonly authenticate: Authenticator,
  ) {}

  async prepare(): Promise<void> {
    await this.content.prepare();
  }

  async handle(request: Request): Promise<Response | null> {
    const user = await this.resolveUser(request.header.headers.get("Authorization"));
    if (!user) {
      return request
        .respond()
        .status(ResponseStatus.Unauthorized)
        .header("WWW-Authenticate", `Basic realm="${this.realm}"`)
        .build();
    }
    request.properties.set(USER_KEY, user);
    return this.content.handle(request);
  }

  private async resolveUser(header: string | undefined): Promise<User | null> {
    if (!header || !header.startsWith("Basic ")) return null;
    let decoded: string;
    try {
      decoded = atob(header.slice(6).trim());
    } catch {
      return null;
    }
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    return await this.authenticate(decoded.slice(0, sep), decoded.slice(sep + 1));
  }
}

export class BasicAuthenticationBuilder implements ConcernBuilder {
  private readonly users = new Map<string, string>();
  private _realm = "Restricted Area";
  private authenticator: Authenticator | null = null;

  realm(realm: string): this {
    this._realm = realm;
    return this;
  }

  add(user: string, password: string): this {
    this.users.set(user, password);
    return this;
  }

  withAuthenticator(authenticator: Authenticator): this {
    this.authenticator = authenticator;
    return this;
  }

  build(content: Handler): Concern {
    const authenticator: Authenticator =
      this.authenticator ??
      ((user, password) => {
        const expected = this.users.get(user);
        return expected !== undefined && expected === password ? new BasicUser(user) : null;
      });
    return new BasicAuthConcern(content, this._realm, authenticator);
  }
}

export const BasicAuthentication = {
  create(): BasicAuthenticationBuilder {
    return new BasicAuthenticationBuilder();
  },
};

export function getUser(request: Request): User | undefined {
  return request.properties.get(USER_KEY) as User | undefined;
}
