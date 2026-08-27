import { Kyoot, makeHandler } from "kyoot";
import type { Kyoot as K, Row } from "kyoot";
import { Model, type Request, type Usage } from "./model.ts";

export const system = (content: string) =>
  Model.intercept((req, next) =>
    next({ ...req, messages: [{ role: "system", content }, ...req.messages] }),
  );

export const config = (patch: Pick<Request, "temperature" | "maxTokens">) =>
  Model.intercept((req, next) => next({ ...req, ...patch }));

export const usage = <A, S extends Row & { "ai/model"?: Request }>(k: K<A, S>) =>
  makeHandler("ai/model", k, {
    initial: { input: 0, output: 0 } as Usage,
    onOp: (req, resume, total) =>
      Model(req).map((c) =>
        resume(c, {
          input: total.input + (c.usage?.input ?? 0),
          output: total.output + (c.usage?.output ?? 0),
        }),
      ),
    onSuccess: (a, total) => Kyoot.succeed([a, total] as const),
  });
