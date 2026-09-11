# GraphQL TS Client

Generate fully typed Typescript clients for your GraphQL APIs.

> **New in v13.** GraphQL servers can answer with part of the data plus errors for the parts that failed. v13 adds `settle()`,
> which turns that into a typed result you can branch on, and classifies every response as `success`, `partial` or `failure`.
> Existing code keeps working unchanged. Start at [Partial responses in one minute](#partial-responses-in-one-minute).
>
> One behaviour changed: retries now only fire on queries that came back with nothing usable ([Retries](#retries)).

## Install

```
yarn add @avantstay/graphql-ts-client
```

## Usage

### Generate the client

```typescript
import { generateTypescriptClient } from '@avantstay/graphql-ts-client'

generateTypescriptClient({
  output: './myAwesomeApi.ts',
  endpoint: 'https://my.awesome-api.com/graphql',
  verbose: process.env.NODE_ENV === 'development', // when true, log requests to the console
  headers: {
    Authorization: 'Bearer 1234567890987654321',
  },
})
```

### Using the generated client

```typescript
import { myAwesomeApi, ArticleStatus } from './myAwesomeApi'

async function somewhereOverTheRainbow() {
  // Set an specific header if needed
  myAwesomeApi.setHeader('Authorization', 'Bearer 010101010101')

  // You can also change the API url
  myAwesomeApi.setUrl('https://my-runtime-url.com/graphql')

  // And configure how retrials should work
  myAwesomeApi.setRetryConfig({
    max: 3,
    before: ({ queryName, query, variables, response }) => {
      // do something before retrying
    },
  })

  // Adding response listeners is also possible
  myAwesomeApi.addResponseListener(({ queryName, query, variables, response }) => {
    // do something whenever a request is responded
  })

  const response = await myAwesomeApi.queries.article({
    // Optionally you can define an alias for this request
    __alias: 'myArticle',
    __args: {
      id: 'article_1',
      status: ArticleStatus.PUBLISHED,
    },
    author: {
      rating: {
        __args: {
          from: '2020-01-01',
          to: '2020-02-01',
        },
      },
    },
    title: true, // selected field
    views: true, // selected field
  })

  console.log(response.author.rating)
  console.log(response.title)
  console.log(response.views)
  console.log(response.body) // compilation time error
}
```

## Partial responses in one minute

**The problem.** A GraphQL server does not have to answer all-or-nothing. When one field fails, it can still return every other
field, and report the failure in an `errors` array alongside the data. Before v13 this client had no way to describe that: you
either got the data or an exception.

**What v13 adds.** Every response is now classified as one of three outcomes:

- `success` — every field you asked for came back.
- `partial` — some fields came back, some failed.
- `failure` — nothing usable came back.

**How you use it.** Call `settle()` instead of the endpoint directly. It never throws; it returns an object you branch on:

```typescript
const result = await myAwesomeApi.queries.article.settle({ title: true })

if (result.outcome === 'success') {
  // result.data is fully populated
} else if (result.outcome === 'partial') {
  // result.data is populated, except the fields listed in result.failedPaths
} else {
  // result.data is null; result.reason says why
}
```

**One extra rule for mutations.** A mutation built from data you loaded earlier must declare where that data came from, in
`__settledSources`. If any of those settled results is not `'success'`, `settle()` refuses to send the mutation.
[Writing with `settle()`](#writing-with-settle) explains why this matters.

**Nothing breaks.** Calling an endpoint directly still throws on any error, exactly as in v12.

Every option, field and helper is listed with its type in the [Reference](#reference) at the end.

## Outcomes

Every request is classified into an `outcome`, and every `outcome: 'failure'` carries a `reason`:

| `outcome`   | Meaning                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `'success'` | No errors; every requested field resolved.                                                                                                    |
| `'partial'` | Some fields failed, the rest came back. `raw()` leaves `data` exactly as the server sent it; `settle()` sets each failed path to `undefined`. |
| `'failure'` | Nothing usable came back for this request; see `reason`.                                                                                      |

| `reason` (only set when `outcome` is `'failure'`) | Meaning                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'http'`                                          | The HTTP response status was ≥ 400, or the request never reached the server (network/transport error).                                                              |
| `'no-data'`                                       | The root field's value was `null`. Either the server sent `null` outright, or a failure deeper in the tree propagated up to it (see [Failed paths](#failed-paths)). |
| `'partial-source'`                                | (mutations only) One of the sources passed to `settle()` in `__settledSources` did not itself settle as `'success'`, so the mutation was never sent.                |

`status` and `outcome` are different things: `status` is the raw HTTP status code, `outcome` is this client's verdict on the
response. Both are present on the results of `raw()`, `memoRaw()` and `settle()`, and on the `response` a response listener
receives. There is no `httpStatus` field — the HTTP status is always called `status`.

## Which call to use

| Call                                        | Behavior                                                                                          | Use it when                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `myAwesomeApi.queries.x(...)` (direct call) | Throws on any error, including a partial response. Identical to v12.                              | You want any error to throw.                                         |
| `raw()`                                     | The v12 response shape, plus `outcome`, `reason` and `failedPaths`.                               | You already inspect `errors` by hand and don't want to change shape. |
| `settle()`                                  | Never throws. Returns a settled result you narrow on `outcome`; failed fields become `undefined`. | Always, in new code. Mutations must also pass `__settledSources`.    |
| `memo()`                                    | Memoised direct call. Throws on any error, including a partial response.                          | Repeated identical reads where any error is fatal.                   |
| `memoRaw()`                                 | Memoised `raw()`. A non-`success` outcome is evicted from the cache, so it is not reused.         | Repeated identical reads you inspect by hand.                        |

## Failed paths

`failedPaths` tells you where data is actually missing, which is often not where the error points.

Here is why they differ. In the schema, `author.rating` is declared non-nullable (`Float!`) and `author` is nullable. When
`rating` fails, the server is not allowed to return `author: { rating: null }`, so it returns `author: null` instead. The error's
`path` still says `author.rating`, because that is the field that failed, but the value that is actually missing is `author`.

In the example below the error's `path` is `author.rating`, but `rating` is non-nullable, so the server nulled `author` instead.
Reading `data.author.rating` would throw; `data.author` is the value you actually have to guard.

So this client follows each error's `path` through the returned data, one segment at a time, and stops at the first `null`. For
the error above it looks at `data.author`, finds `null`, and stops: `failedPaths` gets `author`, not `author.rating`. If nothing
along the path is `null`, the full path is reported as-is.

This is runtime behaviour only. It changes what `raw()` and `settle()` report; it does not change the generated client or the
query you send.

Two helpers make `failedPaths` easier to use than string matching:

```typescript
import { failedAt, errorsAt } from '@avantstay/graphql-ts-client'

failedAt(result, 'author.rating') // true — an ancestor of this path failed
errorsAt(result, 'author') // the errors at or under this path
```

`failedAt` looks _up_: `failedAt(result, 'author.rating')` is `true` because `author`, the parent of `rating`, is in
`failedPaths`. `errorsAt` looks _down_: `errorsAt(result, 'author')` returns the error at `author.rating`, because it sits under
`author`.

In code, use them to decide what to render: `if (failedAt(result, 'author')) showAuthorUnavailable()` and otherwise use
`result.data.author`.

## Reading with `raw()`

```typescript
const result = await myAwesomeApi.queries.article.raw({
  __args: {
    id: 'article_1',
    status: ArticleStatus.PUBLISHED,
  },
  author: {
    rating: {
      __args: { from: '2020-01-01', to: '2020-02-01' },
    },
  },
  title: true,
  views: true,
})
```

Suppose the service behind `author` is unavailable. The GraphQL server sets `author` to `null`, adds an entry to `errors`, and
returns the rest of the data normally. `raw()` hands that response back untouched, with `outcome` and `failedPaths` added, plus
`reason` when the outcome is `'failure'`:

```json
{
  "data": { "title": "Hello world", "views": 42, "author": null },
  "errors": [
    {
      "message": "A downstream service is unavailable",
      "path": ["article", "author", "rating"],
      "extensions": { "code": "SERVICE_UNAVAILABLE", "requestId": "req-1" }
    }
  ],
  "headers": {},
  "status": 200,
  "outcome": "partial",
  "failedPaths": ["author"]
}
```

(Field order above is for readability; the object also carries `warnings`, which is `undefined` when the server sent none.)

`data.author` is `null`, exactly as the server sent it — `raw()` never rewrites `data`. `failedPaths` names `author`, not the
deeper `author.rating` the error itself points to, as explained in [Failed paths](#failed-paths) above.

## Reading with `settle()`

```typescript
const result = await myAwesomeApi.queries.article.settle({
  __args: {
    id: 'article_1',
    status: ArticleStatus.PUBLISHED,
  },
  author: {
    rating: {
      __args: { from: '2020-01-01', to: '2020-02-01' },
    },
  },
  title: true,
  views: true,
})
```

Same request, same server response. `settle()` returns a settled result you narrow on `outcome`: the value of `outcome` tells
TypeScript which of the other fields are populated. It also replaces every failed path with `undefined` rather than `null`, so a
failed field is always distinguishable from a field the server legitimately returned as `null`:

```typescript
{
  outcome: 'partial',
  data: { title: 'Hello world', views: 42, author: undefined },
  errors: [
    {
      message: 'A downstream service is unavailable',
      path: ['author', 'rating'],
      extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'req-1' },
      locations: undefined,
      redacted: false,
    },
  ],
  warnings: [],
  failedPaths: ['author'],
  status: 200,
}
```

Every settled error has the same five fields: `message`, `path`, `extensions`, `locations` and `redacted`. `path`, `extensions`
and `locations` are `undefined` when the server did not send them — as `locations` is here — so the keys are always present.
`redacted` is `true` only when a federation gateway (for example Apollo Router) replaced the real message with its generic
placeholder.

`warnings` carries non-fatal notices the server sent in `extensions.warnings` (or, for older servers, a top-level `warnings`
array). Each is `{ message, code? }`. Warnings never affect `outcome`: a response with warnings and no errors is still
`'success'`.

That object is what this README calls a **settled result**: `{ outcome, data, errors, warnings, failedPaths, status }`, plus
`reason` when `outcome` is `'failure'`.

Narrow on `outcome` before reading `data`. Unnarrowed, TypeScript types it `Data | null`, so every read has to cope with the
`null`; after the narrow, the `'success'` and `'partial'` arms give you the data type directly.

```typescript
if (result.outcome === 'success') {
  console.log(result.data.author.rating) // fully resolved, never undefined
} else if (result.outcome === 'partial') {
  console.log(result.data.author) // possibly undefined
} else {
  console.log(result.reason) // 'http' or 'no-data' — a query never returns 'partial-source'
}
```

### Reading values from a settled result

`data` is `null` when `outcome` is `'failure'`, so narrow on `outcome` before reading from it:

```typescript
if (result.outcome !== 'success') return

const title = result.data.title
```

Narrowing on `outcome` is for TypeScript; the protection against sending incomplete data is `__settledSources`.

**Watch for typos in `__` options.** Every top-level key that starts with `__` is treated as a call option and is not sent to the
server. A misspelled one is dropped without an error: `__retyr: false` does nothing, and TypeScript does not flag it either. The
options that exist are `__args`, `__alias`, `__headers`, `__url`, `__retry` and `__settledSources`; `__typename` is the one `__`
key that is a real field.

## Writing with `settle()`

**Why mutations need `__settledSources`.** Picture an edit screen for an article. It loads the article, shows every field in a
form, and on save sends the whole form back as `updateArticle`'s input. If `author` failed to load, the form holds `undefined` for
it and sends `undefined`; the server reads that as "remove the author" and clears the stored value. The article loses its author
because one field failed to load.

### What `__settledSources` expects

`__settledSources` takes the values you got back from `settle()`.

```typescript
const article = await myAwesomeApi.queries.article.settle({ __args: { id: 'article_1' }, title: true })
// article is a SettledResponse
```

A `SettledResponse` is the object every `settle()` call returns:

```typescript
type SettledResponse<Data> = {
  outcome: 'success' | 'partial' | 'failure' // did everything load?
  data: Data | null // the fields you asked for; null when outcome is 'failure'
  errors: SettledError[] // what the server reported
  failedPaths: string[] // the fields that are missing, e.g. ['author']
  warnings: Warning[] // non-fatal notices from the server
  status?: number // HTTP status; undefined when no request was made
  reason?: 'http' | 'no-data' | 'partial-source' // only when outcome is 'failure'
}
```

Put those objects in `__settledSources`, exactly as you received them:

```typescript
const result = await myAwesomeApi.mutations.updateArticle.settle({
  __settledSources: [article],
  __args: { input: { title: 'Hello world' } },
  title: true,
})
```

`settle()` reads `outcome` on each one. If all are `'success'`, the mutation is sent. If any is `'partial'` or `'failure'`, the
mutation is not sent, and `result` is a `SettledResponse` with `outcome: 'failure'` and `reason: 'partial-source'`.

| You pass                                                              | Result                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `[article]` or `[article, author]`                                    | Accepted. One or more `SettledResponse` values.                            |
| `'none'`                                                              | Accepted. The mutation was not built from any query, for example a create. |
| nothing, `[]`, `null`, `[article.data]`, an object you built yourself | Rejected: the promise rejects with `MissingSourcesError`.                  |

Only values that came from `settle()` count; it marks them with a `Symbol` you cannot set yourself, which is why `article.data` or
a hand-made object is rejected. `__settledSources` is required on `settle()` of a mutation and does not exist on queries.

What TypeScript sees for the mutation call, from the generated client:

```typescript
myAwesomeApi.mutations.updateArticle.settle(input: {
  __settledSources: SettledResponse<unknown>[] | 'none' // required
  __args: { input: UpdateArticleInput } // required when the mutation declares required arguments
  __alias?: string
  __headers?: Record<string, string>
  __url?: string
  __retry?: boolean
  title?: true // any field of Article you want back
  views?: true
  author?: { rating?: true | { __args?: { from?: string; to?: string } } }
}): Promise<SettledResponse<{ title: string }>> // Data is built from the fields you selected
```

When `article` has `outcome: 'success'`, the request is sent and `result` is:

```typescript
{
  outcome: 'success',
  data: { title: 'Hello world' },
  errors: [],
  warnings: [],
  failedPaths: [],
  status: 200,
}
```

### How the check works

1. `settle()` on a query returns a settled result. Its `outcome` records whether every requested field came back.
2. `settle()` on a mutation reads `outcome` on every settled result listed in `__settledSources`.
3. If every `outcome` is `'success'`, the mutation is sent.
4. If any `outcome` is `'partial'` or `'failure'`, the mutation is not sent. The returned result carries `outcome: 'failure'` and
   `reason: 'partial-source'`. The check stops at the first source that is not `'success'`, and the result carries that source's
   `errors`, `warnings` and `failedPaths`.
5. `'failure'` sources block just as `'partial'` ones do. Either way, the payload was built from data that is stale or missing.

A blocked mutation does not throw — it resolves to a `'failure'` result like any other. (The one case where `settle()` _does_
reject is a malformed `__settledSources`; see [Invalid `__settledSources`](#invalid-__settledsources). That is a programming
error, not a runtime condition.)

Handle a blocked result the way you handle any failure: tell the user that editing is unavailable, do not retry, and reload the
data.

### Mutations built from no query

A mutation that creates something new is not built from any earlier query. Say so explicitly with `__settledSources: 'none'`:

```typescript
const result = await myAwesomeApi.mutations.createArticle.settle({
  __settledSources: 'none',
  __args: { input: { title: 'Hello world' } },
  title: true,
})
```

`[]` is rejected because an empty list usually means a list was accidentally emptied, not that there was nothing to check.
`'none'` says the second on purpose.

### What a blocked mutation returns

With a partial `article` in `__settledSources`, no request is made and `result` is:

```typescript
{
  outcome: 'failure',
  reason: 'partial-source',
  data: null,
  errors: [
    {
      message: 'A downstream service is unavailable',
      path: ['author', 'rating'],
      extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'req-1' },
      locations: undefined,
      redacted: false,
    },
  ],
  warnings: [],
  failedPaths: ['author'],
  status: undefined,
}
```

`status` is `undefined` because no HTTP request was made. `errors`, `warnings` and `failedPaths` are copied from the blocking
source, so the caller can point at the same fields that failed to load. `warnings` is `[]` above only because that read carried
none.

### Invalid `__settledSources`

A rejected `__settledSources` (see the table under [What `__settledSources` expects](#what-__settledsources-expects)) makes the
returned promise reject with:

```
MissingSourcesError: settle() on a mutation requires __settledSources: the settled results the payload was built from, or 'none'; an empty array or a non-settled value is not a list of sources
```

## Retries

Retries are off by default (`max: 0`). Configure them with `setRetryConfig`:

```typescript
myAwesomeApi.setRetryConfig({
  max: 3,
  waitBeforeRetry: 250, // ms to wait between attempts; omit for no delay
  before: ({ queryName, query, variables, response }) => {
    // called before each retry, with the response that triggered it
  },
})
```

Retries are deliberately narrow. Only queries are retried, and only when `outcome` is `'failure'` with `reason: 'http'` or
`'no-data'`. Those are the two cases where nothing usable came back, so repeating the request cannot lose anything.

Never retried: any mutation (its server-side effect is unknown once it has errored), and any `'partial'` result (you already have
usable data — retrying would discard it).

Pass `__retry: false` on a single call to opt that call out.

This is the behaviour change in v13 (see the note under the title): v12 retried on any error, and retried mutations too.

## Response listeners

`addResponseListener` fires after every request, success or failure. As of v13, its payload's `response` also carries `outcome`,
`reason` and `failedPaths` alongside the existing fields:

```typescript
myAwesomeApi.addResponseListener(({ queryName, response }) => {
  if (response.outcome !== 'success') {
    trackMetric(`graphql.${queryName}.${response.outcome}`, { reason: response.reason, failedPaths: response.failedPaths })
  }
})
```

For the `raw()` example above, the listener receives:

```json
{
  "queryName": "article",
  "query": "query article($id: ID!, $status: ArticleStatus, $from: IDate, $to: IDate) { article(id:$id,status:$status) { author { rating(from:$from,to:$to)  } title views } }",
  "variables": {
    "id": "article_1",
    "status": "PUBLISHED",
    "from": "2020-01-01",
    "to": "2020-02-01"
  },
  "headers": {},
  "response": {
    "data": { "article": { "title": "Hello world", "views": 42, "author": null } },
    "errors": [
      {
        "message": "A downstream service is unavailable",
        "path": ["article", "author", "rating"],
        "extensions": { "code": "SERVICE_UNAVAILABLE", "requestId": "req-1" }
      }
    ],
    "headers": {},
    "status": 200,
    "outcome": "partial",
    "failedPaths": ["author"]
  }
}
```

(The exact whitespace in `query` depends on your `formatGraphQL`; the string above is the unformatted document.)

Note the shape of `response.data` in the listener: `{ article: { ... } }`, the whole server payload. `raw()` and `settle()` give
you the inner value, `{ title, views, author }`, directly.

## Reference

### Call options

Every endpoint call takes one object: the field selection plus optional keys that start with `__`. The `__` keys are call options.
They configure the request and are never sent to the server. Any other top-level key is a field name.

| Option             | Type                                   | Required                             | Honoured by                  | What it does                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------- | ------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__args`           | the generated `<Operation>Args` type   | when the operation has required args | all calls                    | Arguments of the root field. Becomes GraphQL variables.                                                                                                                                                                                                                                                                                                           |
| `__alias`          | `string`                               | no                                   | all calls                    | Names the operation and aliases the root field. `raw()` and `settle()` unwrap `data` by this alias.                                                                                                                                                                                                                                                               |
| `__headers`        | `Record<string, string>`               | no                                   | all calls                    | Extra HTTP headers for this request only, merged over the client headers.                                                                                                                                                                                                                                                                                         |
| `__url`            | `string`                               | no                                   | all calls                    | Overrides the client URL for this request only.                                                                                                                                                                                                                                                                                                                   |
| `__retry`          | `boolean` (default `true`)             | no                                   | all calls                    | `false` opts this request out of the retry policy set by `setRetryConfig`.                                                                                                                                                                                                                                                                                        |
| `__settledSources` | `SettledResponse<unknown>[] \| 'none'` | **yes, on `settle()` of a mutation** | `settle()` on mutations only | `__settledSources` lists the sources of the payload: the settled results it was built from, or `'none'` when the mutation was not built from any earlier query. Ignored by a mutation's direct call, `memo()` and `raw()`; a query's `raw()` tolerates it, a query's direct call does not. See [What `__settledSources` expects](#what-__settledsources-expects). |
| `__typename`       | `true`                                 | no                                   | all calls                    | The GraphQL meta-field. It is the one `__` key that is a field, not an option.                                                                                                                                                                                                                                                                                    |

Rules for `__settledSources`:

- Must be a non-empty array of settled results (the values `settle()` calls resolved to, kept as they were), or exactly the string
  `'none'`. See [What `__settledSources` expects](#what-__settledsources-expects).
- Omitting it on `settle()` of a mutation is a TypeScript error. Passing `[]`, `null`, an object, or an array holding anything
  that did not come from `settle()` makes the promise reject with `MissingSourcesError`.
- Direct calls and `raw()` accept it and ignore it; they do not check sources.

### Settled result

What `settle()` resolves to. `SettledResponse<Data>` is a union on `outcome`:

| Field         | Type                                                                | Present when                 | Meaning                                                                                                           |
| ------------- | ------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `outcome`     | `'success' \| 'partial' \| 'failure'`                               | always                       | The classification. Narrow on it to read the other fields.                                                        |
| `data`        | the projected data type (`success`, `partial`) / `null` (`failure`) | always                       | On `partial`, every path listed in `failedPaths` is `undefined`.                                                  |
| `reason`      | `'http' \| 'no-data' \| 'partial-source'`                           | `outcome === 'failure'` only | Why nothing usable came back.                                                                                     |
| `errors`      | `SettledError[]` (`[]` on `success`)                                | always                       | Server errors, normalised: `path` is relative to the root field's value, duplicates removed.                      |
| `failedPaths` | `string[]` (`[]` on `success`)                                      | always                       | Dotted paths of the values that are missing, resolved to where the `null` actually landed. See Failed paths.      |
| `warnings`    | `Warning[]`                                                         | always                       | Non-fatal notices from `extensions.warnings` (or a legacy top-level `warnings`). Never affect `outcome`.          |
| `status`      | `number \| undefined`                                               | always                       | HTTP status. `undefined` when no request was made (a blocked mutation) or the transport failed before a response. |

`SettledError` is
`{ message: string; path?: (string | number)[]; extensions?: { code?: string; requestId?: string; errorId?: string; [key: string]: unknown }; locations?: { line: number; column: number }[]; redacted: boolean }`.
`Warning` is `{ message: string; code?: string }`.

### `raw()` result

The v12 shape plus `outcome`, `failedPaths` and, on a failure, `reason`. `data` is never modified.

| Field         | Type                                  | Meaning                                                                                                                  |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `data`        | the projected data type               | The root field's value, exactly as the server sent it.                                                                   |
| `errors`      | `any[]`                               | The server's `errors` array, after `errorsParser` if one is configured.                                                  |
| `warnings`    | `any[] \| undefined`                  | The server's warnings, from `extensions.warnings` or a legacy top-level `warnings`; `undefined` when it sent neither.    |
| `headers`     | `any`                                 | Response headers.                                                                                                        |
| `status`      | `number`                              | HTTP status.                                                                                                             |
| `outcome`     | `'success' \| 'partial' \| 'failure'` | Same classification as `settle()`.                                                                                       |
| `reason`      | `'http' \| 'no-data'`                 | Present only when `outcome` is `'failure'`. `raw()` never returns `'partial-source'`, because it does not check sources. |
| `failedPaths` | `string[]`                            | Same as on a settled result.                                                                                             |

### Errors thrown

| Class                 | Thrown by                                 | When                                                                     |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `GraphQLClientError`  | direct calls and `memo()`                 | The response carried any error. `error.response` is the full raw result. |
| `MissingSourcesError` | `settle()` on a mutation (as a rejection) | `__settledSources` is missing or invalid. See the rules above.           |

Both work with `instanceof` even when the generated client and your code load different copies of this package. `settle()` never
throws for any other reason: transport failures become `outcome: 'failure', reason: 'http'`.

### Helpers

| Export                                      | Signature                                                                                                                                                                  | Use                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `isSettled(value)`                          | `(value: unknown) => value is SettledResponse<unknown>`                                                                                                                    | `true` only for objects returned by `settle()`.                                         |
| `failedAt(result, path)`                    | `(result: SettledResponse<unknown>, path: string) => boolean`                                                                                                              | `true` when `path` or any ancestor of it is in `failedPaths`.                           |
| `errorsAt(result, path)`                    | `(result: SettledResponse<unknown>, path: string) => SettledError[]`                                                                                                       | The errors whose `path` is `path` or nested inside it.                                  |
| `pathToString`, `parsePath`, `isPrefixPath` | `pathToString(path: (string \| number)[]) => string` · `parsePath(text: string) => (string \| number)[]` · `isPrefixPath(ancestor: string, descendant: string) => boolean` | Conversions between `['a', 0, 'b']` and `'a.0.b'`, and ancestor checks on dotted paths. |

---

# For maintainers

## Releasing

1. Open a PR that bumps `version` in `package.json`, get it reviewed and merged into `master`.
2. In GitHub, go to Actions → "Publish to npm" → Run workflow on `master`.

The job runs the tests, skips if the version is already on npm, and publishes with npm trusted publishing. A version containing a
`-` (e.g. `13.0.0-rc.1`) publishes under the `next` dist-tag instead of `latest`, so anyone installing
`@avantstay/graphql-ts-client@latest` is unaffected until the prerelease is promoted.
