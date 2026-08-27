import { Async, Fail, Kyoot, Queue, Ref, type AsyncOp, type Kyoot as K, type Row } from "kyoot";

export interface Job<A> {
  readonly id: string;
  readonly value: A;
}

export interface Scheduler<A> {
  submit(job: Job<A>): K<void, { async: AsyncOp; fail: Queue.QueueShutdown }>;
  readonly queued: K<number, { sync: () => unknown }>;
  cancel(id: string): K<boolean, { async: AsyncOp; sync: () => unknown }>;
  readonly shutdown: K<void, { sync: () => unknown }>;
}

export interface WorkerEvent<A> {
  readonly type: "started" | "completed" | "failed";
  readonly worker: number;
  readonly job: Job<A>;
  readonly error?: unknown;
}

/**
 * A persistent bounded worker pool. `execute` should turn expected job failures
 * into values; defects are reported through `onEvent` and the worker continues.
 */
export const make = <A, S extends Row>(options: {
  readonly concurrency: number;
  readonly queueCapacity?: number;
  readonly execute: (job: Job<A>) => K<void, S>;
  readonly onEvent?: (event: WorkerEvent<A>) => void;
}) =>
  Kyoot.gen(function* () {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
      throw new RangeError("Scheduler concurrency must be a positive integer");

    const queue = yield* Queue.bounded<Job<A>>(options.queueCapacity ?? 1024);
    const active = yield* Ref.make(new Map<string, Async.Fiber<void, any>>());
    const cancelled = yield* Ref.make(new Set<string>());

    const worker = (index: number) =>
      Kyoot.gen(function* () {
        while (true) {
          const taken = yield* queue.take.pipe(Fail.run);
          if (!taken.ok) return;
          const job = taken.value;
          const skip = yield* cancelled.modify((ids) => {
            if (!ids.has(job.id)) return [false, ids] as const;
            const next = new Set(ids);
            next.delete(job.id);
            return [true, next] as const;
          });
          if (skip) continue;
          options.onEvent?.({ type: "started", worker: index, job });
          const fiber = yield* Async.fork(options.execute(job));
          yield* active.update((fibers) => new Map(fibers).set(job.id, fiber));
          const outcome = yield* fiber.await;
          yield* active.update((fibers) => {
            const next = new Map(fibers);
            next.delete(job.id);
            return next;
          });
          if (outcome.ok) options.onEvent?.({ type: "completed", worker: index, job });
          else
            options.onEvent?.({
              type: "failed",
              worker: index,
              job,
              error: outcome.cause,
            });
        }
      });

    const workers: Array<Async.Fiber<void, any>> = [];
    for (let index = 0; index < options.concurrency; index++)
      workers.push(yield* Async.fork(worker(index)));

    const scheduler: Scheduler<A> = {
      submit: (job) => queue.offer(job),
      queued: queue.size,
      cancel: (id) =>
        Kyoot.gen(function* () {
          const fiber = yield* active.get.map((fibers) => fibers.get(id));
          if (fiber) {
            yield* fiber.interrupt;
            return true;
          }
          yield* cancelled.update((ids) => new Set(ids).add(id));
          return false;
        }),
      shutdown: queue.shutdown,
    };

    return { scheduler, workers } as const;
  });

export const awaitWorkers = <A>(
  workers: ReadonlyArray<Async.Fiber<A, unknown>>,
): K<readonly unknown[], { async: AsyncOp }> => Async.all(workers.map((worker) => worker.await));
