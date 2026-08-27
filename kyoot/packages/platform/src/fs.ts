import { effect } from "kyoot";
import type { Kyoot } from "kyoot";

export type Op =
  | { readonly kind: "readFile"; readonly path: string }
  | { readonly kind: "writeFile"; readonly path: string; readonly data: string }
  | { readonly kind: "appendFile"; readonly path: string; readonly data: string }
  | { readonly kind: "readDir"; readonly path: string }
  | { readonly kind: "stat"; readonly path: string }
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "mkdir"; readonly path: string; readonly recursive: boolean }
  | { readonly kind: "remove"; readonly path: string; readonly recursive: boolean }
  | { readonly kind: "rename"; readonly path: string; readonly to: string };

export type Code =
  | "NotFound"
  | "AlreadyExists"
  | "PermissionDenied"
  | "NotADirectory"
  | "IsADirectory"
  | "NotEmpty"
  | "Other";

export class FsError {
  readonly _tag = "FsError";
  readonly op: Op["kind"];
  readonly path: string;
  readonly code: Code;
  readonly message: string;
  constructor(op: Op["kind"], path: string, code: Code, message: string) {
    this.op = op;
    this.path = path;
    this.code = code;
    this.message = message;
  }
}

export interface Stat {
  readonly type: "file" | "directory" | "other";
  readonly size: number;
  readonly mtime: Date;
}

type Answer = {
  readFile: string;
  writeFile: void;
  appendFile: void;
  readDir: string[];
  stat: Stat;
  exists: boolean;
  mkdir: void;
  remove: void;
  rename: void;
};

const fs = effect<Op, unknown, FsError>()("fs");

export const handle = fs.handle;

export const intercept = fs.intercept;

const perform = <O extends Op>(op: O) =>
  fs(op) as Kyoot<Answer[O["kind"]], { fs: Op; fail: FsError }>;

export const readFile = (path: string) => perform({ kind: "readFile", path });

export const writeFile = (path: string, data: string) => perform({ kind: "writeFile", path, data });

export const appendFile = (path: string, data: string) =>
  perform({ kind: "appendFile", path, data });

export const readDir = (path: string) => perform({ kind: "readDir", path });

export const stat = (path: string) => perform({ kind: "stat", path });

export const exists = (path: string) => perform({ kind: "exists", path });

export const mkdir = (path: string, { recursive = false } = {}) =>
  perform({ kind: "mkdir", path, recursive });

export const remove = (path: string, { recursive = false } = {}) =>
  perform({ kind: "remove", path, recursive });

export const rename = (path: string, to: string) => perform({ kind: "rename", path, to });
