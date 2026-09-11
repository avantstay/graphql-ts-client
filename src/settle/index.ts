// The package's public settle surface. Everything else under settle/ is internal and is imported directly, not re-exported here.
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
