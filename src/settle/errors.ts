import { PathSegment, SettledError } from './types'

export const REDACTED_MESSAGE = 'Subgraph errors redacted'

type RawError = { message?: unknown; path?: unknown; extensions?: unknown; locations?: unknown }

function isPathSegment(value: unknown): value is PathSegment {
  return typeof value === 'string' || typeof value === 'number'
}

function normalizePath(rawPath: unknown, rootName: string): PathSegment[] | undefined {
  if (!Array.isArray(rawPath) || !rawPath.every(isPathSegment)) return undefined
  const [first, ...rest] = rawPath as PathSegment[]
  return first === rootName ? rest : (rawPath as PathSegment[])
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

/** Server errors → SettledError[]. Paths lose the root field segment; duplicates collapse. */
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
