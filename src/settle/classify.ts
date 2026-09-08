import { normalizeErrors } from './errors'
import { resolveFailedPath } from './resolve'
import { isPrefixPath, pathToString, setUndefinedAtPath } from './paths'
import { brandSettled, FailureReason, Outcome, PathSegment, SettledError, SettledResponse, Warning } from './types'

export type ClassifyInput = {
  data: unknown
  errors: unknown
  warnings: unknown
  httpStatus: number | undefined
  operation: { kind: 'query' | 'mutation'; alias: string }
  require?: string[]
}

export type Classification = {
  outcome: Outcome
  reason?: FailureReason
  errors: SettledError[]
  warnings: Warning[]
  failedPaths: string[]
  failedSegments: PathSegment[][]
  codes: string[]
  requestIds: string[]
}

function normalizeWarnings(rawWarnings: unknown): Warning[] {
  if (!Array.isArray(rawWarnings)) return []
  return rawWarnings
    .filter(
      (warning): warning is { message: string; code?: unknown } =>
        typeof warning === 'object' && warning !== null && typeof (warning as { message?: unknown }).message === 'string'
    )
    .map(warning => ({ message: warning.message, code: typeof warning.code === 'string' ? warning.code : undefined }))
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)))
}

export function classify(input: ClassifyInput): Classification {
  const errors = normalizeErrors(input.errors, input.operation.alias)
  const warnings = normalizeWarnings(input.warnings)
  const codes = unique(errors.map(error => error.extensions?.code))
  const requestIds = unique(errors.map(error => error.extensions?.requestId ?? error.extensions?.errorId))
  const failure = (reason: FailureReason, failedPaths: string[] = [], failedSegments: PathSegment[][] = []): Classification => ({
    outcome: 'failure',
    reason,
    errors,
    warnings,
    failedPaths,
    failedSegments,
    codes,
    requestIds,
  })

  if (input.httpStatus !== undefined && input.httpStatus >= 400) return failure('http')
  if (input.data === null || input.data === undefined) return failure('no-data')

  const failedSegments: PathSegment[][] = []
  const seen = new Set<string>()
  let rootLost = false
  for (const error of errors) {
    if (!error.path) continue
    const resolved = resolveFailedPath(input.data, error.path)
    if (resolved.path === 'root' || resolved.path.length === 0) {
      rootLost = true
      continue
    }
    const key = pathToString(resolved.path)
    if (seen.has(key)) continue
    seen.add(key)
    failedSegments.push(resolved.path)
  }
  const failedPaths = failedSegments.map(pathToString)

  if (rootLost) return failure('no-data', failedPaths, failedSegments)

  const requiredFailed = (input.require ?? []).some(required =>
    failedPaths.some(failed => isPrefixPath(failed, required) || isPrefixPath(required, failed))
  )
  if (requiredFailed) return failure('required-path', failedPaths, failedSegments)

  if (errors.length > 0) return { outcome: 'partial', errors, warnings, failedPaths, failedSegments, codes, requestIds }
  return { outcome: 'success', errors, warnings, failedPaths: [], failedSegments: [], codes, requestIds }
}

/** Mutates `data` in place: each failed path becomes `undefined`. Only call on an object you own. */
export function applyFailedPaths(data: unknown, failedSegments: PathSegment[][]): void {
  for (const segments of failedSegments) setUndefinedAtPath(data, segments)
}

export function toSettled<Data>(data: Data, classification: Classification, httpStatus?: number): SettledResponse<Data> {
  const { outcome, reason, errors, warnings, failedPaths, codes, requestIds } = classification
  const shared = { errors, warnings, failedPaths, codes, requestIds, httpStatus }
  if (outcome === 'failure') return brandSettled({ ...shared, outcome, reason: reason as FailureReason, data: null })
  if (outcome === 'partial') return brandSettled({ ...shared, outcome, data })
  return brandSettled({ ...shared, outcome, data, errors: [] as [], failedPaths: [] as [] })
}
