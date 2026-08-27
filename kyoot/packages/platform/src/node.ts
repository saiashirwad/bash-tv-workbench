import * as http from "node:http";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { Async, Fail, Result } from "kyoot";
import type { Kyoot as K, Row } from "kyoot";
import * as Command from "./command.ts";
import * as FileSystem from "./fs.ts";
import * as Http from "./http.ts";

const attempt = <A, E>(f: () => Promise<A>, onError: (e: unknown) => E) =>
  Async.fromPromise(() =>
    f().then(
      (value) => ({ ok: true as const, value }),
      (e: unknown) => ({ ok: false as const, error: onError(e) }),
    ),
  );

const codes: Record<string, FileSystem.Code> = {
  ENOENT: "NotFound",
  EEXIST: "AlreadyExists",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  ENOTDIR: "NotADirectory",
  EISDIR: "IsADirectory",
  ENOTEMPTY: "NotEmpty",
};

const fsError = (op: FileSystem.Op, e: unknown) => {
  const { code = "", message } = e as { code?: string; message: string };
  return new FileSystem.FsError(op.kind, op.path, codes[code] ?? "Other", message);
};

const performFs = (op: FileSystem.Op): Promise<unknown> => {
  switch (op.kind) {
    case "readFile":
      return fsp.readFile(op.path, "utf8");
    case "writeFile":
      return fsp.writeFile(op.path, op.data);
    case "appendFile":
      return fsp.appendFile(op.path, op.data);
    case "readDir":
      return fsp.readdir(op.path);
    case "stat":
      return fsp.stat(op.path).then((s) => ({
        type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
        size: s.size,
        mtime: s.mtime,
      }));
    case "exists":
      return fsp.access(op.path).then(
        () => true,
        (e: unknown) => {
          const code = (e as { code?: string }).code;
          if (code === "ENOENT" || code === "ENOTDIR") return false;
          throw e;
        },
      );
    case "mkdir":
      return fsp.mkdir(op.path, { recursive: op.recursive });
    case "remove":
      return op.recursive
        ? fsp.rm(op.path, { recursive: true })
        : fsp
            .stat(op.path)
            .then((s) => (s.isDirectory() ? fsp.rmdir(op.path) : fsp.unlink(op.path)));
    case "rename":
      return fsp.rename(op.path, op.to);
  }
};

export const fs = FileSystem.handle({
  onOp: (op, resume) =>
    attempt(
      () => performFs(op),
      (e) => fsError(op, e),
    ).map((r) => (r.ok ? resume(r.value) : resume.with(Fail.fail(r.error)))),
});

const exec = (op: Command.Op) =>
  new Promise<Command.Output>((resolve, reject) => {
    const child = execFile(
      op.command,
      op.args,
      { cwd: op.cwd, env: op.env && { ...process.env, ...op.env } },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : err.code;
        if (typeof code === "number") resolve({ code, stdout, stderr });
        else reject(err);
      },
    );
    child.stdin?.end(op.stdin ?? "");
  });

export const command = Command.handle({
  onOp: (op, resume) =>
    attempt(
      () => exec(op),
      (e) => new Command.CommandError(op.command, (e as Error).message),
    ).map((r) => (r.ok ? resume(r.value) : resume.with(Fail.fail(r.error)))),
});

export interface NodeHttpServerOptions {
  readonly port: number;
  readonly host?: string;
}

export const makeNodeHttpServer = (options: NodeHttpServerOptions): Http.HttpServer => ({
  address: {
    port: options.port,
    host: options.host ?? "0.0.0.0",
  },
  serve: (handler) =>
    Async.fromPromise(
      (signal) =>
        new Promise<Result<Http.HttpServerError, void>>((resolve) => {
          const s = http.createServer(async (req, res) => {
            try {
              const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
              const headers = new Headers();
              for (const [k, v] of Object.entries(req.headers)) {
                if (v !== undefined) {
                  if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
                  else headers.set(k, v);
                }
              }
              const controller = new AbortController();
              req.on("close", () => controller.abort());

              const hasBody = req.method !== "GET" && req.method !== "HEAD";
              const body = hasBody
                ? new ReadableStream<Uint8Array>({
                    start(ctrl) {
                      req.on("data", (chunk) => ctrl.enqueue(new Uint8Array(chunk)));
                      req.on("end", () => ctrl.close());
                      req.on("error", (err) => ctrl.error(err));
                    },
                  })
                : undefined;

              const request = new Request(url.href, {
                method: req.method,
                headers,
                body,
                // @ts-expect-error duplex is required in node fetch Request when body is stream
                duplex: "half",
                signal: controller.signal,
              });

              const response = await handler(request);
              res.statusCode = response.status;
              response.headers.forEach((value, key) => res.setHeader(key, value));
              if (response.body) {
                const reader = response.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  res.write(Buffer.from(value));
                }
              }
              res.end();
            } catch {
              if (!res.headersSent) {
                res.statusCode = 500;
                res.end("Internal Server Error");
              }
            }
          });

          s.on("error", (err) =>
            resolve(Result.fail(new Http.HttpServerError("serve", err.message))),
          );
          s.listen(options.port, options.host ?? "0.0.0.0", () => {
            signal.addEventListener(
              "abort",
              () => {
                s.close(() => resolve(Result.ok(undefined)));
              },
              { once: true },
            );
          });
        }),
    ).map((res) => Fail.fromResult(res)) as never,
});

export const provide = <A, S extends Row & { fs?: FileSystem.Op; command?: Command.Op }>(
  k: K<A, S>,
) => k.pipe(fs, command);
