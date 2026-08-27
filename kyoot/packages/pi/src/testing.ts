import { Async, Fail } from "kyoot";
import type { Command, PiEvent } from "./protocol.ts";
import {
  PiProtocolError,
  PiTransportError,
  type OpenOptions,
  type Service,
  type Session,
} from "./service.ts";

export interface Script {
  readonly events?: readonly PiEvent[];
  readonly responses?: Readonly<Record<string, unknown>>;
}

async function* eventStream(events: readonly PiEvent[]) {
  for (const event of events) yield event;
}

/** Deterministic Pi service for orchestrator tests. */
export const scripted = (script: Script = {}): Service => {
  let nextId = 0;
  const sessions = new Set<string>();

  const known = (session: Session) => sessions.has(session.id);

  return {
    open: (_options: OpenOptions) =>
      Async.fromPromise(async () => {
        const session = { id: `test-${++nextId}`, pid: 1000 + nextId };
        sessions.add(session.id);
        return session;
      }) as never,

    request: <A>(session: Session, command: Command) => {
      if (!known(session))
        return Fail.fail(new PiTransportError("session", "Unknown Pi session")) as never;
      const response = script.responses?.[command.type];
      if (response instanceof Error)
        return Fail.fail(new PiProtocolError(command.type, response.message)) as never;
      return Async.fromPromise(async () => response as A) as never;
    },

    events: (session) =>
      known(session)
        ? (Async.fromPromise(async () => eventStream(script.events ?? [])) as never)
        : (Fail.fail(new PiTransportError("session", "Unknown Pi session")) as never),

    close: (session) => {
      sessions.delete(session.id);
      return Async.fromPromise(async () => undefined) as never;
    },
  };
};
