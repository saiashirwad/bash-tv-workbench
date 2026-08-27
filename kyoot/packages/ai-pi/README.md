# @kyoot/ai-pi

Use Pi model transports as `@kyoot/ai` providers. The Node adapter currently exposes Bash.tv's session-bound `bashtv/free` alias without placing entitlement values in model requests, events, errors, or persisted configuration.

```ts
import { AI, Events } from "@kyoot/ai";
import { BashTv } from "@kyoot/ai-pi/node";
import { Fail, Kyoot } from "kyoot";

const answer = await AI.gen(Answer, "Analyze this result", {
  tools: [search, inspect],
}).pipe(BashTv.model("free", { thinking: "low" }), Events.print, Fail.orThrow, Kyoot.runPromise);
```

`free` is the model alias Bash.tv exposes to the sandbox, not necessarily the upstream model identifier. Bash.tv may retarget that alias. Generic request controls stay in `Mode.config`:

```ts
program.pipe(
  Mode.config({ temperature: 0.2, maxTokens: 4_000 }),
  BashTv.model("free", { thinking: "low" }),
);
```

## Runtime boundary

Each completion starts a small helper that imports Pi's lower-level `streamSimple` transport. It does not start the Pi coding agent and does not execute Pi tools; tool calls return to `@kyoot/ai`, which executes Kyoot tools itself.

The default Node adapter reads only an allowlist of environment names from the current process and, when available, the active Bash.tv platform process. Those values are inherited directly by the helper and never cross its JSONL protocol. `make({ environment, helperPath })` exists for embedding and tests.

The adapter is intentionally Node- and Bash.tv-specific. It does not modify `/opt/pi-mono`, use the internal bridge port, or attach to the live interactive Pi session.
