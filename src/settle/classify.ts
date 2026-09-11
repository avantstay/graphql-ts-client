import { normalizeErrors } from './errors'
import { resolveFailedPath } from './resolve'
import { pathToString, setUndefinedAtPath } from './paths'
import { brandSettled, FailureReason, PathSegment, SettledError, SettledResponse, Warning } from './types'

/** Everything `classify()` needs from one response: the root field's value, its errors and warnings, and the HTTP status. */
export type ClassifyInput = {
  data: unknown
  errors: unknown
  warnings: unknown
  status: number | undefined
  rootName: string
}

type ClassificationBase = {
  errors: SettledError[]
  warnings: Warning[]
  failedPaths: string[]
  failedSegments: PathSegment[][]
}

/** Mirrors SettledResponse's shape, so `reason` exists on the failure arm only and no consumer has to cast. */
export type Classification =
  | (ClassificationBase & { outcome: 'success' | 'partial' })
  | (ClassificationBase & { outcome: 'failure'; reason: FailureReason })

function normalizeWarnings(rawWarnings: unknown): Warning[] {
  if (!Array.isArray(rawWarnings)) return []
  return rawWarnings
    .filter(
      (warning): warning is { message: string; code?: unknown } =>
        typeof warning === 'object' && warning !== null && typeof (warning as { message?: unknown }).message === 'string'
    )
    .map(warning => ({ message: warning.message, code: typeof warning.code === 'string' ? warning.code : undefined }))
}

/** The distinct paths the server actually nulled, plus whether the root field itself was lost. */
function resolveFailures(data: unknown, errors: SettledError[]): { failedSegments: PathSegment[][]; rootLost: boolean } {
  const failedSegments: PathSegment[][] = []
  const seen = new Set<string>()
  let rootLost = false
  for (const error of errors) {
    if (!error.path) continue
    const resolved = resolveFailedPath(data, error.path)
    if (resolved === 'root') {
      rootLost = true
      continue
    }
    const key = pathToString(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    failedSegments.push(resolved)
  }
  return { failedSegments, rootLost }
}

/** Decides whether a response succeeded, is partial, or failed, resolving each error to the path that actually failed. */
export function classify(input: ClassifyInput): Classification {
  const errors = normalizeErrors(input.errors, input.rootName)
  const warnings = normalizeWarnings(input.warnings)
  const failure = (reason: FailureReason, failedPaths: string[], failedSegments: PathSegment[][]): Classification => ({
    outcome: 'failure',
    reason,
    errors,
    warnings,
    failedPaths,
    failedSegments,
  })

  if (input.status !== undefined && input.status >= 400) return failure('http', [], [])
  if (input.data === null || input.data === undefined) return failure('no-data', [], [])

  const { failedSegments, rootLost } = resolveFailures(input.data, errors)
  const failedPaths = failedSegments.map(pathToString)

  if (rootLost) return failure('no-data', failedPaths, failedSegments)

  if (errors.length > 0) return { outcome: 'partial', errors, warnings, failedPaths, failedSegments }
  return { outcome: 'success', errors, warnings, failedPaths: [], failedSegments: [] }
}

/** Mutates `data` in place, setting every failed path to `undefined` — only call it on an object you own. */
export function applyFailedPaths(data: unknown, failedSegments: PathSegment[][]): void {
  for (const segments of failedSegments) setUndefinedAtPath(data, segments)
}

/** Assembles the branded `SettledResponse` a classification describes. */
export function toSettled<Data>(data: Data, classification: Classification, status?: number): SettledResponse<Data> {
  const { errors, warnings, failedPaths } = classification
  const shared = { errors, warnings, failedPaths, status }
  switch (classification.outcome) {
    case 'failure':
      return brandSettled({ ...shared, outcome: 'failure' as const, reason: classification.reason, data: null })
    case 'partial':
      return brandSettled({ ...shared, outcome: 'partial' as const, data })
    case 'success':
      return brandSettled({ ...shared, outcome: 'success' as const, data, errors: [] as [], failedPaths: [] as [] })
  }
}
