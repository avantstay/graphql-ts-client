/** One segment of a GraphQL response path: an object key, or a list index. */
export type PathSegment = string | number

/** How a response is classified: everything resolved, some fields failed, or nothing usable came back. */
export type Outcome = 'success' | 'partial' | 'failure'

/** Why an `outcome: 'failure'` failed; `'partial-source'` is produced for mutations only. */
export type FailureReason = 'http' | 'no-data' | 'partial-source'

/** One GraphQL error, with its path made relative to the root field's value. */
export type SettledError = {
  message: string
  path?: PathSegment[]
  /** `requestId` is the current backend field; `errorId` is the legacy fallback. */
  extensions?: { code?: string; requestId?: string; errorId?: string; [key: string]: unknown }
  locations?: { line: number; column: number }[]
  redacted: boolean
}

/** A non-fatal notice from the server; warnings never change `outcome`. */
export type Warning = { message: string; code?: string }

type SettledBase = {
  errors: SettledError[]
  failedPaths: string[]
  warnings: Warning[]
  status?: number
}

/** Every requested field resolved, so `errors` and `failedPaths` are empty by construction, and the empty tuples make that checkable. */
export type SettledSuccess<Data> = SettledBase & { outcome: 'success'; data: Data; errors: []; failedPaths: [] }

/** Some fields failed: `data` is populated, with each path in `failedPaths` set to `undefined`. */
export type SettledPartial<Data> = SettledBase & { outcome: 'partial'; data: Data }

/** Nothing usable came back: `data` is `null` and `reason` says why. */
export type SettledFailure = SettledBase & { outcome: 'failure'; data: null; reason: FailureReason }

/** What `settle()` returns — narrow on `outcome` to read `data`. */
export type SettledResponse<Data> = SettledSuccess<Data> | SettledPartial<Data> | SettledFailure

/** A settled result of unknown shape — what `__settledSources` holds. */
export type AnySettled = SettledResponse<unknown>

/** The settled results a mutation payload was built from, or `'none'` when it was built from no query. Every array entry must be an object returned by `settle()`. */
export type MutationSources = AnySettled[] | 'none'

/** Non-enumerable brand on every object returned by `settle()`, for consumers like mobx-async. */
export const SETTLED_BRAND = Symbol.for('@avantstay/graphql-ts-client/settled')

/** `settle()` is the only producer of this brand — nothing else may claim to be a settled result. */
export function brandSettled<Value extends object>(value: Value): Value {
  Object.defineProperty(value, SETTLED_BRAND, { value: true, enumerable: false })
  return value
}

/** True when `value` was returned by `settle()`, including across bundle boundaries (the brand is symbol-keyed). */
export function isSettled(value: unknown): value is AnySettled {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SETTLED_BRAND] === true
}
