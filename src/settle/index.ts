// The package's public settle surface. Internals (classify, settleRaw, sources) are imported directly and are not exported here.
export { isSettled, SETTLED_BRAND } from './types'
export { failedAt, errorsAt, pathToString, parsePath, isPrefixPath } from './paths'
export type {
  AnySettled,
  FailureReason,
  MutationSources,
  Outcome,
  PathSegment,
  SettledError,
  SettledFailure,
  SettledPartial,
  SettledResponse,
  SettledSuccess,
  Warning,
} from './types'
