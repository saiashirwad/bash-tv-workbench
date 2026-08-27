import { Async, InterruptedError, Kyoot, Resource, runFiber } from "kyoot";
import type { AsyncOp, Env, FiberHandle, Kyoot as K, Only, Row } from "kyoot";

type Tag<E> = Env.Tag<string, E>;
type AnyTag = Tag<any>;

export type Inject = Record<string, AnyTag>;

export type Resolve<I extends Inject> = {
  [N in keyof I]: I[N] extends Env.Tag<string, infer E> ? E : never;
};

export interface Ctx {
  set<E>(tag: Tag<E>, impl: E): K<void, { resource: Resource.ResourceOp }>;
}

export interface Component<I extends Inject = Inject> {
  readonly inject: I;
  readonly run: (deps: Resolve<I>, ctx: Ctx) => K<unknown, any>;
}

export const component = <I extends Inject, S extends Row>(spec: {
  inject: I;
  run: (deps: Resolve<I>, ctx: Ctx) => K<unknown, S> & Only<S, "resource" | "async" | "clock">;
}): Component<I> => spec as Component<I>;

export interface Handle {
  readonly active: boolean;
  readonly error: unknown;
  remove(): K<void, { async: AsyncOp }>;
}

interface Entry {
  readonly component: Component;
  target: boolean;
  active: boolean;
  landed: boolean;
  fiber?: FiberHandle;
  inertia?: Promise<void>;
  error?: unknown;
}

type Outcome = { type: "landed" } | { type: "interrupted" } | { type: "failed"; error: unknown };

const root: Entry = {
  component: { inject: {}, run: () => Async.never },
  target: true,
  active: true,
  landed: true,
};

export class Registry implements Ctx {
  private readonly bindings = new Map<AnyTag, { impl: unknown; owner: Entry }>();
  private readonly entries: Entry[] = [];

  use(component: Component<any>): K<Handle, { async: AsyncOp }> {
    const entry: Entry = { component, target: false, active: false, landed: false };
    return Async.fromPromise(async () => {
      this.entries.push(entry);
      await this.refresh(entry);
      return {
        get active() {
          return entry.active;
        },
        get error() {
          return entry.error;
        },
        remove: () =>
          Async.fromPromise(async () => {
            await this.retarget(entry, false);
            const i = this.entries.indexOf(entry);
            if (i >= 0) this.entries.splice(i, 1);
          }),
      };
    });
  }

  set<E>(tag: Tag<E>, impl: E) {
    return this.bind(root, tag, impl);
  }

  dispose(): K<void, { async: AsyncOp }> {
    return Async.fromPromise(async () => {
      for (const entry of [...this.entries].reverse()) await this.retarget(entry, false);
      this.entries.length = 0;
    });
  }

  settled(): K<void, { async: AsyncOp }> {
    return Async.fromPromise(async () => {
      await Promise.all(this.entries.map((e) => e.inertia));
    });
  }

  private bind<E>(owner: Entry, tag: Tag<E>, impl: E) {
    return Resource.acquire(
      () => {
        if (this.bindings.has(tag)) throw new Error(`duplicate provider for ${tag.key}`);
        this.bindings.set(tag, { impl, owner });
        if (owner.landed) void this.notify([tag]);
      },
      () => {
        if (this.bindings.get(tag)?.owner !== owner) return;
        this.bindings.delete(tag);
        void this.notify([tag]);
      },
    );
  }

  private provided(owner: Entry) {
    return [...this.bindings].filter(([, b]) => b.owner === owner).map(([tag]) => tag);
  }

  private satisfied(entry: Entry) {
    return Object.values(entry.component.inject).every(
      (tag) => this.bindings.get(tag)?.owner.landed ?? false,
    );
  }

  private notify(tags: ReadonlyArray<AnyTag>) {
    const dependents = this.entries.filter((e) =>
      Object.values(e.component.inject).some((t) => tags.includes(t)),
    );
    return Promise.all(dependents.map((e) => this.refresh(e)));
  }

  private refresh(entry: Entry) {
    return this.retarget(entry, this.satisfied(entry));
  }

  private retarget(entry: Entry, target: boolean) {
    entry.target = target;
    if (!target && entry.fiber && !entry.landed) entry.fiber.interrupt();
    return this.transition(entry);
  }

  private transition(entry: Entry): Promise<void> {
    if (entry.inertia) return entry.inertia;
    if (entry.target === entry.active) return Promise.resolve();
    const run = async () => {
      while (entry.target !== entry.active) {
        if (entry.target) await this.activate(entry);
        else await this.deactivate(entry);
      }
    };
    entry.inertia = run().then(() => {
      entry.inertia = undefined;
      if (entry.target !== entry.active) void this.transition(entry);
    });
    return entry.inertia;
  }

  private async activate(entry: Entry) {
    const deps = Object.fromEntries(
      Object.entries(entry.component.inject).map(([name, tag]) => [
        name,
        this.bindings.get(tag)!.impl,
      ]),
    );
    const ctx: Ctx = { set: (tag, impl) => this.bind(entry, tag, impl) };
    let land!: () => void;
    const landed = new Promise<Outcome>((resolve) => (land = () => resolve({ type: "landed" })));
    const program = Kyoot.gen(function* () {
      yield* entry.component.run(deps, ctx);
      yield* Async.fromPromise(async () => land());
      yield* Async.never;
    }).pipe(Resource.run);
    entry.active = true;
    entry.landed = false;
    entry.error = undefined;
    entry.fiber = runFiber(program);
    const died = entry.fiber.promise.then(
      (): Outcome => ({ type: "interrupted" }),
      (e: unknown): Outcome =>
        e instanceof InterruptedError ? { type: "interrupted" } : { type: "failed", error: e },
    );
    const outcome = await Promise.race([landed, died]);
    if (outcome.type === "landed") {
      entry.landed = true;
      void this.notify(this.provided(entry));
      return;
    }
    entry.active = false;
    entry.fiber = undefined;
    if (outcome.type === "failed") {
      entry.error = outcome.error;
      entry.target = false;
    }
  }

  private async deactivate(entry: Entry) {
    entry.active = false;
    entry.landed = false;
    await this.notify(this.provided(entry));
    entry.fiber?.interrupt();
    await entry.fiber?.promise.catch(() => {});
    entry.fiber = undefined;
  }
}

export const make = () =>
  Resource.acquire(
    () => new Registry(),
    (registry) => registry.dispose(),
  );
