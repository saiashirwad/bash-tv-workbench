# kyoot

An experimental, minimal Effects system for Typescript heavily inspired by Kyo

| Package                                                    | What                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`kyoot`](packages/kyoot)                                  | The core: algebraic effects for TypeScript, handlers, fibers, and the built-in effects |
| [`@kyoot/ai`](packages/ai)                                 | Language models, tools, and providers as effects                                       |
| [`@kyoot/ai-pi`](packages/ai-pi)                           | Pi model transports as `@kyoot/ai` providers, including Bash.tv `free`                 |
| [`@kyoot/platform`](packages/platform)                     | File system and processes as effects, with handlers per runtime                        |
| [`@kyoot/pi`](packages/pi)                                 | Pi coding-agent RPC sessions, Node transport, test service, and scheduler proof        |
| [`@kyoot/registry`](packages/registry)                     | Components that load, unload, and hot swap at runtime                                  |
| [`@kyoot/rpc`](packages/rpc)                               | Standard-Schema typed queries, mutations, streams, and Web transports                  |
| [`@kyoot/schema`](packages/schema)                         | Sync and async Standard Schema validation utilities                                    |
| [`@kyoot/sync`](packages/sync)                             | Revisioned server-authoritative collection synchronization                             |
| [`@kyoot/workbench-protocol`](packages/workbench-protocol) | Shared Workbench RPC and sync contracts                                                |

```
mise exec -- npm ci
pnpm typecheck
pnpm test
```
