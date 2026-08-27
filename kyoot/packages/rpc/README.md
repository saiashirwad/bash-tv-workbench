# @kyoot/rpc

Transport-neutral typed RPC built from Standard Schema contracts and Kyoot programs.

```ts
const Books = Rpc.api("books", {
  get: Rpc.query({ input: BookId, output: Book, error: BookNotFound }),
  save: Rpc.mutation({ input: SaveBook, output: Book }),
  changes: Rpc.stream({ input: Cursor, output: BookChange }),
});

const server = Rpc.router(Books, {
  get: ({ id }) => Store.get(id),
  save: (book) => Store.save(book),
  changes: ({ after }) => Events.after(after),
});

const BooksClient = Rpc.client(Books);
const book = BooksClient.get({ id }).pipe(
  Rpc.provide(FetchRpc.fetchTransport({ url: "/api/rpc" })),
);
```

`@kyoot/rpc/http` contains a browser Fetch transport and a portable Web `Request`/`Response` server adapter. Authentication, authorization, origin checks, and rate limiting wrap the HTTP app; types and validation do not replace those controls.

Request handlers run in child fibers. Unary aborts and stream disconnects interrupt those fibers and run their finalizers. The in-memory transport uses the same envelopes and is intended for contract and integration tests.
