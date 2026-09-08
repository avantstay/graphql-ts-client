import { AnySettled, PathSegment, SettledError } from './types'

export function pathToString(path: PathSegment[]): string {
  return path.map(segment => String(segment)).join('.')
}

export function parsePath(text: string): PathSegment[] {
  if (text === '') return []
  return text.split('.').map(segment => (/^\d+$/.test(segment) ? Number(segment) : segment))
}

export function isPrefixPath(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(prefix + '.')
}

export function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
}

export function getAtPath(value: unknown, path: PathSegment[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (!isContainer(current)) return undefined
    current = (current as Record<string, unknown>)[segment as string]
  }
  return current
}

export function setUndefinedAtPath(value: unknown, path: PathSegment[]): void {
  if (path.length === 0) return
  const parent = getAtPath(value, path.slice(0, -1))
  if (!isContainer(parent)) return
  const lastSegment = path[path.length - 1]
  ;(parent as Record<string, unknown>)[lastSegment as string] = undefined
}

/** True when `path` or one of its ancestors failed. */
export function failedAt(result: AnySettled, path: string): boolean {
  return result.failedPaths.some(failed => isPrefixPath(failed, path))
}

/** The errors whose path is `path` or lies under it. */
export function errorsAt(result: AnySettled, path: string): SettledError[] {
  return result.errors.filter(error => error.path !== undefined && isPrefixPath(path, pathToString(error.path)))
}
