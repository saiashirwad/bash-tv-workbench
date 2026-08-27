import { posix } from "node:path";
import { Fail, Kyoot, makeHandler } from "kyoot";
import type { Kyoot as K, Row } from "kyoot";
import { FsError, type Code, type Op } from "./fs.ts";

const { resolve, dirname, basename } = posix;

const under = (path: string, root: string) =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

export const fs =
  (initial: Record<string, string> = {}) =>
  <A, S extends Row & { fs?: Op }>(k: K<A, S>) => {
    const files = new Map<string, { data: string; mtime: Date }>();
    const dirs = new Set(["/"]);
    const mkdirp = (dir: string) => {
      for (let d = dir; !dirs.has(d); d = dirname(d)) dirs.add(d);
    };
    for (const [path, data] of Object.entries(initial)) {
      mkdirp(dirname(resolve("/", path)));
      files.set(resolve("/", path), { data, mtime: new Date() });
    }

    const run = (op: Op): unknown => {
      const path = resolve("/", op.path);
      const fail = (code: Code, message: string): never => {
        throw new FsError(op.kind, op.path, code, message);
      };
      const requireDir = (dir: string) => {
        if (files.has(dir)) fail("NotADirectory", `${dir} is a file`);
        if (!dirs.has(dir)) fail("NotFound", `${dir} does not exist`);
      };
      const children = (dir: string) =>
        [...files.keys(), ...dirs]
          .filter((p) => p !== "/" && dirname(p) === dir)
          .map((p) => basename(p));
      const subtree = (root: string) =>
        [...files.keys(), ...dirs].filter((p) => p !== "/" && under(p, root));
      switch (op.kind) {
        case "readFile":
          if (dirs.has(path)) fail("IsADirectory", `${path} is a directory`);
          return files.get(path)?.data ?? fail("NotFound", `${path} does not exist`);
        case "writeFile":
        case "appendFile": {
          requireDir(dirname(path));
          if (dirs.has(path)) fail("IsADirectory", `${path} is a directory`);
          const before = op.kind === "appendFile" ? (files.get(path)?.data ?? "") : "";
          files.set(path, { data: before + op.data, mtime: new Date() });
          return;
        }
        case "readDir":
          requireDir(path);
          return children(path);
        case "stat": {
          const file = files.get(path);
          if (file) return { type: "file", size: file.data.length, mtime: file.mtime };
          if (dirs.has(path)) return { type: "directory", size: 0, mtime: new Date(0) };
          return fail("NotFound", `${path} does not exist`);
        }
        case "exists":
          return files.has(path) || dirs.has(path);
        case "mkdir": {
          if (op.recursive) {
            if (files.has(path)) fail("AlreadyExists", `${path} exists`);
            for (let d = dirname(path); !dirs.has(d); d = dirname(d)) {
              if (files.has(d)) fail("NotADirectory", `${d} is a file`);
            }
            return mkdirp(path);
          }
          if (files.has(path) || dirs.has(path)) fail("AlreadyExists", `${path} exists`);
          requireDir(dirname(path));
          return dirs.add(path);
        }
        case "remove":
          if (files.delete(path)) return;
          if (!dirs.has(path)) fail("NotFound", `${path} does not exist`);
          if (!op.recursive && children(path).length > 0) fail("NotEmpty", `${path} is not empty`);
          for (const p of subtree(path)) {
            files.delete(p);
            dirs.delete(p);
          }
          return;
        case "rename": {
          const to = resolve("/", op.to);
          requireDir(dirname(to));
          if (!files.has(path) && !dirs.has(path)) fail("NotFound", `${path} does not exist`);
          for (const p of subtree(path)) {
            const moved = to + p.slice(path.length);
            const file = files.get(p);
            if (file) {
              files.delete(p);
              files.set(moved, file);
            } else {
              dirs.delete(p);
              dirs.add(moved);
            }
          }
          return;
        }
      }
    };

    return makeHandler("fs", k, {
      onOp: (op, resume) => {
        try {
          return resume(run(op));
        } catch (e) {
          if (e instanceof FsError) return resume.with(Fail.fail(e));
          throw e;
        }
      },
      onSuccess: (a) =>
        Kyoot.succeed([a, Object.fromEntries([...files].map(([p, f]) => [p, f.data]))] as const),
    });
  };
