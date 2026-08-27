# @kyoot/schema

Small utilities for existing [Standard Schema](https://standardschema.dev/) validators. This package does not define a new schema language.

```ts
import { parseAsync, jsonSchema, ValidationError } from "@kyoot/schema";

const value = await parseAsync(schema, input);
const wireSchema = jsonSchema(schema);
```

Features:

- Separate Standard Schema input and output types.
- Synchronous and asynchronous validation.
- Complete issue arrays, including issue paths.
- Standard JSON Schema input/output conversion when exposed by the validator.
