export type PathSegment = PropertyKey | { readonly key: PropertyKey };

export interface Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PathSegment>;
}

export type Result<A> =
  | { readonly value: A; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<Issue> };

export interface StandardSchema<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version?: number;
    readonly vendor?: string;
    readonly validate: (input: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
    readonly jsonSchema?: {
      readonly input: (options: { readonly target: "draft-2020-12" }) => Record<string, unknown>;
      readonly output?: (options: { readonly target: "draft-2020-12" }) => Record<string, unknown>;
    };
  };
}

export type Input<S> = S extends StandardSchema<infer A, any> ? A : never;
export type Output<S> = S extends StandardSchema<any, infer A> ? A : never;

export class ValidationError extends Error {
  readonly _tag = "ValidationError";
  readonly issues: ReadonlyArray<Issue>;
  constructor(issues: ReadonlyArray<Issue>) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

const validated = <A>(result: Result<A>): A => {
  if (result.issues) throw new ValidationError(result.issues);
  return result.value;
};

export const parse = <I, O>(schema: StandardSchema<I, O>, input: unknown): O => {
  const result = schema["~standard"].validate(input);
  if (result instanceof Promise)
    throw new TypeError("schema validation is asynchronous; use parseAsync");
  return validated(result);
};

export const parseAsync = async <I, O>(schema: StandardSchema<I, O>, input: unknown): Promise<O> =>
  validated(await schema["~standard"].validate(input));

export const safeParse = <I, O>(schema: StandardSchema<I, O>, input: unknown): Result<O> => {
  const result = schema["~standard"].validate(input);
  if (result instanceof Promise)
    throw new TypeError("schema validation is asynchronous; use safeParseAsync");
  return result;
};

export const safeParseAsync = async <I, O>(
  schema: StandardSchema<I, O>,
  input: unknown,
): Promise<Result<O>> => schema["~standard"].validate(input);

export const jsonSchema = (
  schema: StandardSchema<any, any>,
  direction: "input" | "output" = "input",
): Record<string, unknown> => {
  const standard = schema["~standard"].jsonSchema;
  if (!standard) throw new TypeError("schema does not expose Standard JSON Schema");
  const convert = direction === "output" ? (standard.output ?? standard.input) : standard.input;
  return convert({ target: "draft-2020-12" });
};
