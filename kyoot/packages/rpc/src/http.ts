import {
  RpcTransportError,
  type RequestEnvelope,
  type Router,
  type StreamEnvelope,
  type Transport,
} from "./index.ts";

export interface FetchOptions {
  readonly url: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

const decode = async (response: Response) => {
  if (!response.ok) throw new RpcTransportError(`RPC HTTP ${response.status}`, response.status);
  try {
    return await response.json();
  } catch {
    throw new RpcTransportError("RPC response was not JSON", response.status);
  }
};

const lines = (response: Response, signal: AbortSignal): AsyncIterable<StreamEnvelope> => ({
  async *[Symbol.asyncIterator]() {
    if (!response.ok) throw new RpcTransportError(`RPC HTTP ${response.status}`, response.status);
    if (!response.body) throw new RpcTransportError("RPC stream has no body", response.status);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    const abort = () => void reader.cancel(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffered += next.value;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line) yield JSON.parse(line) as StreamEnvelope;
          newline = buffered.indexOf("\n");
        }
      }
      if (buffered.trim()) yield JSON.parse(buffered) as StreamEnvelope;
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  },
});

export const fetchTransport = (options: FetchOptions): Transport => {
  const runFetch = options.fetch ?? globalThis.fetch;
  const post = (path: string, request: RequestEnvelope, signal: AbortSignal) =>
    runFetch(`${options.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(request),
      signal,
    });
  return {
    request: async (request, signal) => decode(await post("", request, signal)),
    subscribe: (request, signal) => ({
      async *[Symbol.asyncIterator]() {
        const response = await post("/stream", request, signal);
        yield* lines(response, signal);
      },
    }),
  };
};

export interface AppOptions {
  readonly maxBodyBytes?: number;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const body = async (request: Request, limit: number): Promise<RequestEnvelope> => {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit)
    throw new RpcTransportError("RPC request is too large", 413);
  return JSON.parse(text) as RequestEnvelope;
};

/** Portable Web Request/Response adapter. Authentication wraps this app. */
export const httpApp =
  (router: Router, options: AppOptions = {}) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
      return json({ error: "unsupported_media_type" }, 415);
    try {
      const envelope = await body(request, options.maxBodyBytes ?? 1_000_000);
      if (new URL(request.url).pathname.endsWith("/stream")) {
        const encoder = new TextEncoder();
        const iterator = router.subscribe(envelope, request.signal)[Symbol.asyncIterator]();
        return new Response(
          new ReadableStream({
            async pull(controller) {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
            },
            async cancel() {
              await iterator.return?.();
            },
          }),
          { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } },
        );
      }
      return json(await router.request(envelope, request.signal));
    } catch (error) {
      const status = error instanceof RpcTransportError && error.status ? error.status : 400;
      return json({ error: "invalid_request" }, status);
    }
  };
