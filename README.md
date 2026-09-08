# GraphQL TS Client

Generate fully typed Typescript clients for your GraphQL APIs.

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
import { myAwesomeApi, AssetType, Granularity, OnBoardingStage } from './myAwesomeApi'

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

  const response = await myAwesomeApi.queries.globalIndicators({
    // Optionally you can define an alias for this request
    __alias: 'myCustomGlobalIndicators',
    __args: {
      liveStatus: OnBoardingStage.COMPLETED,
      assetType: AssetType.LEASED,
      granularity: Granularity.DAILY,
    },
    customerExperience: {
      avgRating: {
        __args: {
          from: '2020-01-01',
          to: '2020-02-01',
        },
      },
    },
    lorem: true, // selected field
    ipsum: true, // selected field
  })

  console.log(response.customerExperience.avgRating)
  console.log(response.lorem)
  console.log(response.ipsum)
  console.log(response.dolor) // compilation time error
}
```

## Outcomes

Every request is classified into an `outcome`, and every `outcome: 'failure'` carries a `reason`:

| `outcome`   | Meaning                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `'success'` | No errors; every requested field resolved.                                                  |
| `'partial'` | Some field failed but nothing required did; `data` still carries everything that came back. |
| `'failure'` | Nothing usable came back for this request; see `reason`.                                    |

| `reason` (only set when `outcome` is `'failure'`) | Meaning                                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `'http'`                                          | The HTTP response status was ≥ 400, or the request never reached the server (network/transport error).                             |
| `'no-data'`                                       | The server returned no data for the root field — it was `null`, or a failure bubbled all the way up to the root field.             |
| `'required-path'`                                 | A path listed in `__require` (or an ancestor or descendant of it) failed.                                                          |
| `'partial-source'`                                | (mutations only) One of the `__sources` passed to `settle()` did not itself settle as `'success'`, so the mutation was never sent. |

`status` is the HTTP status; `outcome` is the classification. `raw()`, `memoRaw()` and response listeners expose it as `status`;
`settle()` exposes the same value as `httpStatus`.

## Reading with `raw()`

```typescript
const result = await myAwesomeApi.queries.globalIndicators.raw({
  __args: {
    liveStatus: OnBoardingStage.COMPLETED,
    assetType: AssetType.LEASED,
    granularity: Granularity.DAILY,
  },
  customerExperience: {
    avgRating: {
      __args: { from: '2020-01-01', to: '2020-02-01' },
    },
  },
  lorem: true,
  ipsum: true,
})
```

If a downstream service is unavailable when `customerExperience` resolves, the backend nulls `customerExperience` and returns an
error alongside the rest of the data. `raw()` returns the response untouched:

```json
{
  "data": { "lorem": "dolor sit amet", "ipsum": 42, "customerExperience": null },
  "errors": [
    {
      "message": "A downstream service is unavailable",
      "path": ["globalIndicators", "customerExperience", "avgRating"],
      "extensions": { "code": "SERVICE_UNAVAILABLE", "requestId": "req-1" }
    }
  ],
  "headers": {},
  "status": 200,
  "outcome": "partial",
  "failedPaths": ["customerExperience"],
  "codes": ["SERVICE_UNAVAILABLE"],
  "requestIds": ["req-1"]
}
```

`data.customerExperience` is `null`, exactly as the server sent it — `raw()` never rewrites `data`. `failedPaths` names
`customerExperience`, not the deeper `customerExperience.avgRating` the error itself points to; see "Failed paths" below for why.
`reason` is present only when `outcome` is `'failure'` — it's absent here because this response is `'partial'`.

## Reading with `settle()`

```typescript
const result = await myAwesomeApi.queries.globalIndicators.settle({
  __args: {
    liveStatus: OnBoardingStage.COMPLETED,
    assetType: AssetType.LEASED,
    granularity: Granularity.DAILY,
  },
  customerExperience: {
    avgRating: {
      __args: { from: '2020-01-01', to: '2020-02-01' },
    },
  },
  lorem: true,
  ipsum: true,
})
```

Same request, same server response. `settle()` returns a branded, discriminated result, and replaces every failed path with
`undefined` — never `null`, so it can't be confused with a legitimate null the server returned:

```typescript
{
  outcome: 'partial',
  data: { lorem: 'dolor sit amet', ipsum: 42, customerExperience: undefined },
  errors: [
    {
      message: 'A downstream service is unavailable',
      path: ['customerExperience', 'avgRating'],
      extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'req-1' },
      redacted: false,
    },
  ],
  warnings: [],
  failedPaths: ['customerExperience'],
  codes: ['SERVICE_UNAVAILABLE'],
  requestIds: ['req-1'],
  httpStatus: 200,
}
```

(the error also carries a `locations` field when the server sends one; omitted above because this server didn't)

Narrow on `outcome` to get exhaustive, typed access to `data`:

```typescript
if (result.outcome === 'success') {
  console.log(result.data.customerExperience.avgRating) // fully resolved, never undefined
} else if (result.outcome === 'partial') {
  console.log(result.data.customerExperience) // possibly undefined
} else {
  console.log(result.reason) // 'http' | 'no-data' | 'required-path' | 'partial-source'
}
```

## Writing with `settle()`

A mutation is never retried, even when retries are enabled: once errors come back for a mutation, the server-side outcome is
unknown — the write may have partially applied. `settle()` never retries a mutation for you; if you need to recover, refetch and
let the user decide what to do next.

Mutations often build their payload from earlier settled queries. Pass those settled results as `__sources` so `settle()` can
refuse to send a mutation built from incomplete data:

```typescript
const indicators = await myAwesomeApi.queries.globalIndicators.settle({
  __args: {
    liveStatus: OnBoardingStage.COMPLETED,
    assetType: AssetType.LEASED,
    granularity: Granularity.DAILY,
  },
  customerExperience: {
    avgRating: {
      __args: { from: '2020-01-01', to: '2020-02-01' },
    },
  },
  lorem: true,
  ipsum: true,
})

if (indicators.outcome !== 'success') return

const result = await myAwesomeApi.mutations.updateGlobalIndicators.settle({
  __sources: [indicators],
  __args: { input: { lorem: indicators.data.lorem } },
  lorem: true,
})
```

When `indicators` settled as `'success'`, the request is sent and `result` is:

```typescript
{
  outcome: 'success',
  data: { lorem: 'dolor sit amet' },
  errors: [],
  warnings: [],
  failedPaths: [],
  codes: [],
  requestIds: [],
  httpStatus: 200,
}
```

When a mutation has no query sources — a create form, say — say so explicitly instead of passing sources:

```typescript
const result = await myAwesomeApi.mutations.updateGlobalIndicators.settle({
  __sources: { none: 'create form' },
  __args: { input: { lorem: 'dolor sit amet' } },
  lorem: true,
})
```

If any source did not settle as `'success'`, `settle()` blocks the mutation before sending it — no request goes out — and returns:

```typescript
{
  outcome: 'failure',
  reason: 'partial-source',
  data: null,
  errors: [
    {
      message: 'A downstream service is unavailable',
      path: ['customerExperience', 'avgRating'],
      extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'req-1' },
      redacted: false,
    },
  ],
  warnings: [],
  failedPaths: ['customerExperience'],
  codes: ['SERVICE_UNAVAILABLE'],
  requestIds: ['req-1'],
  httpStatus: undefined,
}
```

Omitting `__sources` entirely, passing an empty array, or passing `{ none: '' }` (or whitespace) all make the returned promise
reject with `MissingSourcesError` — `settle()` is async, so this is a rejection, not a synchronous throw — and an empty array is
never treated as "no sources needed":

```
MissingSourcesError: settle() on a mutation requires __sources: the settled results the payload was built from, or { none: reason }; an empty array is not a source list
```

## Required paths

```typescript
const result = await myAwesomeApi.queries.globalIndicators.settle({
  __args: {
    liveStatus: OnBoardingStage.COMPLETED,
    assetType: AssetType.LEASED,
    granularity: Granularity.DAILY,
  },
  __require: ['customerExperience'],
  customerExperience: {
    avgRating: {
      __args: { from: '2020-01-01', to: '2020-02-01' },
    },
  },
  lorem: true,
  ipsum: true,
})
```

`customerExperience` failed, and it's listed in `__require`, so the whole result fails instead of coming back partial:

```typescript
{
  outcome: 'failure',
  reason: 'required-path',
  data: null,
  errors: [
    {
      message: 'A downstream service is unavailable',
      path: ['customerExperience', 'avgRating'],
      extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'req-1' },
      redacted: false,
    },
  ],
  warnings: [],
  failedPaths: ['customerExperience'],
  codes: ['SERVICE_UNAVAILABLE'],
  requestIds: ['req-1'],
  httpStatus: 200,
}
```

`__require` accepts dotted paths (e.g. `'customerExperience.avgRating'`) and matches a failure at that exact path, at an ancestor
of it, or at a descendant of it.

## Failed paths

A non-null field can't hold `null`, so when it fails, GraphQL nulls the nearest nullable ancestor instead — not the field itself.
The error's `path` still points at the field that actually failed (e.g. `customerExperience.avgRating`), which is rarely where the
`null` landed. `graphql-ts-client` resolves this at classification time: it walks the error's `path` through the response `data`
until it reaches the first `null` (or the end of the path, if nothing along it is null), and reports that point as the failed path
— that's why `failedPaths` said `customerExperience` above instead of `customerExperience.avgRating`: `customerExperience` is
where the data actually went missing. Nothing is generated for this; it only changes what `raw()` and `settle()` report.

## Retries

Retries are off by default (`max: 0`). Configure them with `setRetryConfig`:

```typescript
myAwesomeApi.setRetryConfig({
  max: 3,
  before: ({ queryName, query, variables, response }) => {
    // called before each retry
  },
})
```

Even with retries enabled, only queries are retried, and only for `outcome: 'failure'` with `reason: 'http'` or `'no-data'` — the
two failures where nothing usable came back and the request is safe to repeat. A `'partial'` result, a `'required-path'` failure,
and any mutation are never retried automatically. Pass `__retry: false` on a single call to opt it out of retries.

This is a behaviour change in v13: previous versions retried on any error and also retried mutations.

## Response listeners

`addResponseListener` fires after every request, success or failure. Its payload's `response` now carries `outcome`, `reason` and
`failedPaths` alongside the existing fields:

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
  "queryName": "globalIndicators",
  "query": "query globalIndicators($liveStatus: OnBoardingStage, $assetType: AssetType, $granularity: Granularity, $from: IDate, $to: IDate) { globalIndicators(liveStatus:$liveStatus,assetType:$assetType,granularity:$granularity) { customerExperience { avgRating(from:$from,to:$to) } lorem ipsum } }",
  "variables": {
    "liveStatus": "COMPLETED",
    "assetType": "LEASED",
    "granularity": "DAILY",
    "from": "2020-01-01",
    "to": "2020-02-01"
  },
  "headers": {},
  "response": {
    "data": { "globalIndicators": { "lorem": "dolor sit amet", "ipsum": 42, "customerExperience": null } },
    "errors": [
      {
        "message": "A downstream service is unavailable",
        "path": ["globalIndicators", "customerExperience", "avgRating"],
        "extensions": { "code": "SERVICE_UNAVAILABLE", "requestId": "req-1" }
      }
    ],
    "headers": {},
    "status": 200,
    "outcome": "partial",
    "failedPaths": ["customerExperience"],
    "codes": ["SERVICE_UNAVAILABLE"],
    "requestIds": ["req-1"]
  }
}
```

`response.data` is keyed by the root field name (`globalIndicators`) here, unlike `raw()`'s `data`, which is unwrapped to the
field's own value. (The real payload also carries an internal `classification` field, consumed by `settle()`; it isn't part of the
public contract and shouldn't be relied on.)

## Releasing

Bump `version` in `package.json`. A version containing a `-` (e.g. `13.0.0-rc.1`) publishes under the `next` npm dist-tag instead
of `latest`, so adopters installing `graphql-ts-client@latest` are unaffected until the prerelease is promoted.
