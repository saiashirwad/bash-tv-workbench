import { Env, type AsyncOp, type Kyoot as K } from "kyoot";

export interface HttpHeaders {
  readonly [key: string]: string | readonly string[] | undefined;
}

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly signal: AbortSignal;
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json<A = unknown>(): Promise<A>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body?: BodyInit | null;
}

export interface Address {
  readonly port: number;
  readonly host: string;
  readonly family?: string;
}

export class HttpServerError {
  readonly _tag = "HttpServerError";
  readonly operation: string;
  readonly message: string;
  constructor(operation: string, message: string) {
    this.operation = operation;
    this.message = message;
  }
}

export type HttpHandler = (request: Request) => Promise<Response> | Response;

export interface HttpServer {
  readonly address: Address;
  serve(handler: HttpHandler): K<void, { async: AsyncOp; fail: HttpServerError }>;
}

export const HttpServer = Env.tag<HttpServer>()("http_server");

export type RoutePattern = string | RegExp;
export interface RouteHandler {
  readonly method?: string;
  readonly pattern: RoutePattern;
  readonly handle: (
    request: Request,
    params: Record<string, string>,
  ) => Promise<Response> | Response;
}

export class HttpRouter {
  private readonly routes: RouteHandler[] = [];

  route(
    method: string | undefined,
    pattern: RoutePattern,
    handle: (request: Request, params: Record<string, string>) => Promise<Response> | Response,
  ): this {
    this.routes.push({ method: method?.toUpperCase(), pattern, handle });
    return this;
  }

  get(
    pattern: RoutePattern,
    handle: (request: Request, params: Record<string, string>) => Promise<Response> | Response,
  ): this {
    return this.route("GET", pattern, handle);
  }

  post(
    pattern: RoutePattern,
    handle: (request: Request, params: Record<string, string>) => Promise<Response> | Response,
  ): this {
    return this.route("POST", pattern, handle);
  }

  delete(
    pattern: RoutePattern,
    handle: (request: Request, params: Record<string, string>) => Promise<Response> | Response,
  ): this {
    return this.route("DELETE", pattern, handle);
  }

  put(
    pattern: RoutePattern,
    handle: (request: Request, params: Record<string, string>) => Promise<Response> | Response,
  ): this {
    return this.route("PUT", pattern, handle);
  }

  all(
    pattern: RoutePattern,
    handle: (request: Request, params: Record<string, string>) => Promise<Response> | Response,
  ): this {
    return this.route(undefined, pattern, handle);
  }

  handle: HttpHandler = async (request: Request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    for (const route of this.routes) {
      if (route.method && route.method !== method) continue;
      const params = matchPath(route.pattern, pathname);
      if (params !== null) {
        return await route.handle(request, params);
      }
    }
    return new Response("Not Found", { status: 404 });
  };
}

const matchPath = (pattern: RoutePattern, path: string): Record<string, string> | null => {
  if (pattern instanceof RegExp) {
    const match = pattern.exec(path);
    if (!match) return null;
    return (match.groups as Record<string, string>) ?? {};
  }
  if (pattern === path || pattern === "*") return {};

  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);

  if (patternSegments.length !== pathSegments.length && !patternSegments.includes("*")) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const pSeg = patternSegments[i];
    const pathSeg = pathSegments[i];
    if (pSeg === undefined) return null;

    if (pSeg === "*") {
      params["wildcard"] = pathSegments.slice(i).join("/");
      return params;
    }
    if (pSeg.startsWith(":")) {
      params[pSeg.slice(1)] = decodeURIComponent(pathSeg ?? "");
      continue;
    }
    if (pSeg !== pathSeg) return null;
  }
  return params;
};
