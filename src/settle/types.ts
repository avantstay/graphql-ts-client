export type PathSegment = string | number

export type Outcome = 'success' | 'partial' | 'failure'

export type FailureReason = 'http' | 'no-data' | 'required-path' | 'partial-source'

export type SettledError = {
  message: string
  path?: PathSegment[]
  /** `requestId` is the current backend field; `errorId` is the legacy fallback. */
  extensions?: { code?: string; requestId?: string; errorId?: string; [key: string]: unknown }
  locations?: { line: number; column: number }[]
  redacted: boolean
}

export type Warning = { message: string; code?: string }

type SettledBase = {
  errors: SettledError[]
  failedPaths: string[]
  warnings: Warning[]
  codes: string[]
  requestIds: string[]
  httpStatus?: number
}

export type SettledSuccess<Data> = SettledBase & { outcome: 'success'; data: Data; errors: []; failedPaths: [] }
export type SettledPartial<Data> = SettledBase & { outcome: 'partial'; data: Data }
export type SettledFailure = SettledBase & { outcome: 'failure'; data: null; reason: FailureReason }

export type SettledResponse<Data> = SettledSuccess<Data> | SettledPartial<Data> | SettledFailure
export type AnySettled = SettledResponse<unknown>

/** Settled results a mutation payload was built from, or an explicit reason there are none. */
export type MutationSources = AnySettled[] | { none: string }

/** Non-enumerable brand on every object returned by `settle()`, for consumers like mobx-async. */
export const SETTLED_BRAND = Symbol.for('@avantstay/graphql-ts-client/settled')

export function brandSettled<Value extends object>(value: Value): Value {
  Object.defineProperty(value, SETTLED_BRAND, { value: true, enumerable: false })
  return value
}

export function isSettled(value: unknown): value is AnySettled {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SETTLED_BRAND] === true
}
