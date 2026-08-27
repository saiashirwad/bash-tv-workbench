import {
  Async,
  Emit,
  Env,
  Fail,
  Kyoot,
  Resource,
  type AsyncOp,
  type Kyoot as K,
  type Row,
} from "kyoot";
import type {
  AgentEndEvent,
  Command,
  CompactResult,
  PiEvent,
  SessionState,
  ThinkingLevel,
} from "./protocol.ts";

export interface Session {
  readonly id: string;
  readonly pid?: number;
}

export interface OpenOptions {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly extensions?: readonly string[];
  readonly continue?: boolean;
}

export class PiTransportError {
  readonly _tag = "PiTransportError";
  readonly operation: string;
  readonly message: string;
  constructor(operation: string, message: string) {
    this.operation = operation;
    this.message = message;
  }
}

export class PiProtocolError {
  readonly _tag = "PiProtocolError";
  readonly operation: string;
  readonly message: string;
  constructor(operation: string, message: string) {
    this.operation = operation;
    this.message = message;
  }
}

export class PiExited {
  readonly _tag = "PiExited";
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  constructor(code: number | null, signal: string | null, stderr: string) {
    this.code = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

export type PiError = PiTransportError | PiProtocolError | PiExited;
export type PiRow = { async: AsyncOp; fail: PiError };

export interface Service {
  open(options: OpenOptions): K<Session, PiRow>;
  request<A = unknown>(session: Session, command: Command): K<A, PiRow>;
  events(session: Session): K<AsyncIterable<PiEvent>, PiRow>;
  close(session: Session): K<void, PiRow>;
}

export const Service = Env.tag<Service>()("pi");

export const prompt = (session: Session, message: string) =>
  Service.get().map((pi) => pi.request<void>(session, { type: "prompt", message }));

export const followUp = (session: Session, message: string) =>
  Service.get().map((pi) => pi.request<void>(session, { type: "follow_up", message }));

export const abort = (session: Session) =>
  Service.get().map((pi) => pi.request<void>(session, { type: "abort" }));

export const state = (session: Session) =>
  Service.get().map((pi) => pi.request<SessionState>(session, { type: "get_state" }));

export const compact = (session: Session, customInstructions?: string) =>
  Service.get().map((pi) =>
    pi.request<CompactResult>(session, { type: "compact", customInstructions }),
  );

const waitForAgentEnd = (events: AsyncIterable<PiEvent>) =>
  Kyoot.gen(function* () {
    const iterator = events[Symbol.asyncIterator]();
    while (true) {
      const next = yield* Async.fromPromise((signal) => {
        const abort = () => void iterator.return?.();
        signal.addEventListener("abort", abort, { once: true });
        return iterator.next().finally(() => signal.removeEventListener("abort", abort));
      });
      if (next.done)
        return yield* Fail.fail(new PiTransportError("events", "Pi event stream closed"));
      yield* Emit.value(next.value);
      if (next.value.type === "agent_end") return next.value as AgentEndEvent;
    }
  });

/**
 * Open a Pi session for one lexical scope and close it on every exit path.
 * Async-safe acquisition still requires Kyoot's planned acquire/use/release primitive.
 */
export const scoped = <A, S extends Row>(
  options: OpenOptions,
  use: (session: Session) => K<A, S>,
) =>
  Service.get().map((pi) =>
    pi
      .open(options)
      .map((session) =>
        Resource.acquire(
          () => session,
          () => pi.close(session),
        ).map(() => use(session)),
      )
      .pipe(Fail.run, Resource.run)
      .map(Fail.fromResult),
  );

/** Send one prompt and emit Pi events until the corresponding agent turn ends. */
export const runTurn = (session: Session, message: string) =>
  Service.get().map((pi) =>
    pi
      .events(session)
      .map((events) =>
        pi.request<void>(session, { type: "prompt", message }).map(() => waitForAgentEnd(events)),
      ),
  );
