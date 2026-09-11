import { PathSegment, SettledError } from './types'

/** The message a subgraph error carries once its detail has been redacted. */
export const REDACTED_MESSAGE = 'Subgraph errors redacted'

type RawError = { message?: unknown; path?: unknown; extensions?: unknown; locations?: unknown }

function isPathSegment(value: unknown): value is PathSegment {
  return typeof value === 'string' || typeof value === 'number'
}

/** The error path relative to the root field, or `undefined` when it is absent *or* malformed — both are treated as path-less. */
function normalizePath(rawPath: unknown, rootName: string): PathSegment[] | undefined {
  if (!Array.isArray(rawPath)) return undefined
  const path: PathSegment[] = []
  for (const segment of rawPath) {
    if (!isPathSegment(segment)) return undefined
    path.push(segment)
  }
  return path[0] === rootName ? path.slice(1) : path
}

function normalizeOne(rawError: unknown, rootName: string): SettledError | undefined {
  if (typeof rawError !== 'object' || rawError === null) return undefined
  const { message, path, extensions, locations } = rawError as RawError
  const normalizedMessage = typeof message === 'string' ? message : 'Unknown error'
  return {
    message: normalizedMessage,
    path: normalizePath(path, rootName),
    extensions: typeof extensions === 'object' && extensions !== null ? (extensions as SettledError['extensions']) : undefined,
    locations: Array.isArray(locations) ? (locations as SettledError['locations']) : undefined,
    redacted: normalizedMessage === REDACTED_MESSAGE,
  }
}

function dedupeKey(error: SettledError): string {
  return [error.path ? error.path.join('.') : '', error.extensions?.code ?? '', error.message].join('|')
}

/** Normalises server errors into SettledError[], stripping the root field from each path and collapsing duplicates. */
export function normalizeErrors(rawErrors: unknown, rootName: string): SettledError[] {
  if (!Array.isArray(rawErrors)) return []
  const seen = new Set<string>()
  const normalized: SettledError[] = []
  for (const rawError of rawErrors) {
    const error = normalizeOne(rawError, rootName)
    if (!error) continue
    const key = dedupeKey(error)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(error)
  }
  return normalized
}
