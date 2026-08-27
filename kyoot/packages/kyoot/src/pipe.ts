export interface Pipeable {
  pipe<A>(this: A): A;
  pipe<A, B>(this: A, ab: (a: A) => B): B;
  pipe<A, B, C>(this: A, ab: (a: A) => B, bc: (b: B) => C): C;
  pipe<A, B, C, D>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D;
  pipe<A, B, C, D, E>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
  ): E;
  pipe<A, B, C, D, E, F>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
  ): F;
  pipe<A, B, C, D, E, F, G>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
    fg: (f: F) => G,
  ): G;
  pipe<A, B, C, D, E, F, G, H>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
    fg: (f: F) => G,
    gh: (g: G) => H,
  ): H;
}

type AnyPipeFn = (value: any) => any;

export function pipeArguments(self: unknown, fns: readonly AnyPipeFn[]): any {
  let value: any = self;
  for (const fn of fns) value = fn(value);
  return value;
}
