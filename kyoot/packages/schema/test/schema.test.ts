import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  jsonSchema,
  parse,
  parseAsync,
  safeParseAsync,
  ValidationError,
  type StandardSchema,
} from "@kyoot/schema";

test("parse preserves Standard Schema issues", () => {
  const schema = z.object({ count: z.number().int() });
  assert.throws(
    () => parse(schema, { count: "no" }),
    (error) =>
      error instanceof ValidationError &&
      error.issues.length === 1 &&
      error.issues[0]?.path?.[0] === "count",
  );
});

test("async schemas validate and preserve transformed output", async () => {
  const schema: StandardSchema<string, number> = {
    "~standard": {
      types: { input: "", output: 0 },
      validate: async (input) =>
        typeof input === "string"
          ? { value: input.length }
          : { issues: [{ message: "expected string", path: [] }] },
    },
  };
  assert.equal(await parseAsync(schema, "kyoot"), 5);
  assert.deepEqual(await safeParseAsync(schema, 1), {
    issues: [{ message: "expected string", path: [] }],
  });
});

test("jsonSchema uses the Standard JSON Schema converter", () => {
  const converted = jsonSchema(z.object({ id: z.string() }));
  assert.equal(converted.type, "object");
});
