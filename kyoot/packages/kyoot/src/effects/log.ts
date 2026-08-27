import { makeHandler, op, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

export type Level = "debug" | "info" | "warn" | "error";

export interface Entry {
  readonly level: Level;
  readonly message: string;
}

const at = (level: Level) => (message: string) => op<void>()("log", { level, message } as Entry);

export const debug = at("debug");
export const info = at("info");
export const warn = at("warn");
export const error = at("error");

export const print = <A, S extends Row & { log?: Entry }>(k: Kyoot<A, S>) =>
  makeHandler("log", k, {
    onOp: ({ level, message }, resume) => {
      console[level === "debug" ? "log" : level](message);
      return resume(undefined);
    },
  });

// The list is a cell made per run, so fibers forked under the handler log
// into the same list.
export const collect = <A, S extends Row & { log?: Entry }>(k: Kyoot<A, S>) =>
  makeHandler("log", k, {
    create: () => [] as Entry[],
    onOp: (entry, resume, entries) => {
      entries.push(entry);
      return resume(undefined);
    },
    onSuccess: (a, entries) => succeed([a, entries] as const),
  });

export const discard = <A, S extends Row & { log?: Entry }>(k: Kyoot<A, S>) =>
  makeHandler("log", k, { onOp: (_e, resume) => resume(undefined) });
