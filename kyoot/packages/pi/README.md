# @kyoot/pi

Pi coding-agent sessions as Kyoot programs. This package wraps Pi's JSON-lines RPC mode; it does not replace Pi and does not use `@kyoot/ai`.

```ts
import { Emit, Fail, Kyoot } from "kyoot";
import { Pi } from "@kyoot/pi";
import { service } from "@kyoot/pi/node";

const program = Pi.scoped(
  {
    cwd: "/work/project",
    sessionDir: "/state/run/session",
    provider: "bashtv",
    model: "free",
    thinking: "low",
  },
  (session) => Pi.runTurn(session, "Review this project"),
).pipe(
  Pi.Service.provide(
    service({
      cliPath: "/opt/pi-mono/packages/coding-agent/dist/cli.js",
      providerExtension: "/app/child-provider.mjs",
      // Supply inherited authorization only here. Never put it in session values.
      environment: () => inheritedPlatformEnvironment(),
    }),
  ),
  Emit.forEach(persistEvent),
  Fail.orThrow,
);

await Kyoot.runPromise(program);
```

## Exports

- `@kyoot/pi` — typed protocol, session service, scoped sessions, turns.
- `@kyoot/pi/node` — detached Node process and Pi JSONL RPC transport.
- `@kyoot/pi/testing` — deterministic scripted service.
- `@kyoot/pi/scheduler` — bounded persistent worker-pool proof.

## Boundaries

- Pi remains responsible for tools, sessions, continuation, compaction, and model calls.
- The Node handler correlates RPC responses and broadcasts session events.
- Environment authorization is injected through a callback and is never returned or persisted.
- `Pi.scoped` closes sessions on success, failure, defect, and interruption.
- Filesystem confinement, durable run state, worktrees, and HTTP authorization belong to the orchestrator, not this package.

`Pi.scoped` currently closes a successfully opened session through `Resource`. The Node handler also listens for interruption during `open`, closing the cancellation gap. A general async-safe acquire/use/release primitive still belongs in Kyoot core.
