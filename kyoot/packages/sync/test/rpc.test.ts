import assert from "node:assert/strict";
import { test } from "node:test";
import { inMemory, router } from "@kyoot/rpc";
import { authority, make } from "@kyoot/sync";
import { SyncRpc, fromRpc, handlers } from "@kyoot/sync/rpc";
import { client } from "@kyoot/rpc";

test("sync runs end to end over the generic RPC stream", async () => {
  const server = authority({
    apply: async (mutation) => ({
      changes: [
        {
          collection: "runs",
          operation: "put" as const,
          key: String((mutation.input as any).id),
          value: { id: String((mutation.input as any).id), title: "rpc" },
        },
      ],
    }),
  });
  const rpcClient = client(SyncRpc);
  const transport = inMemory(router(SyncRpc, handlers(server)));
  const engine = make(fromRpc(rpcClient, transport), { reconnectMs: 1 });
  await engine.start();
  await engine.mutate("runs/create", { id: "r1" });
  assert.equal((engine.collection<any>("runs").get("r1") as any).title, "rpc");
  engine.stop();
});
