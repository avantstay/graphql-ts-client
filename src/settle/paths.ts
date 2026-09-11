import { AnySettled, PathSegment, SettledError } from './types'

/** `['rooms', 0, 'beds']` → `'rooms.0.beds'`. */
export function pathToString(path: PathSegment[]): string {
  return path.map(segment => String(segment)).join('.')
}

/** `'rooms.0.beds'` → `['rooms', 0, 'beds']`; all-digit segments become numbers. */
export function parsePath(text: string): PathSegment[] {
  if (text === '') return []
  return text.split('.').map(segment => (/^\d+$/.test(segment) ? Number(segment) : segment))
}

/** True when `descendant` is `ancestor` or lies under it, matching whole segments only (`room` is not a prefix of `rooms`). */
export function isPrefixPath(ancestor: string, descendant: string): boolean {
  return descendant === ancestor || descendant.startsWith(ancestor + '.')
}

export function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
}

export function childAt(container: Record<string, unknown> | unknown[], segment: PathSegment): unknown {
  return (container as Record<PathSegment, unknown>)[segment]
}

/** The value at `path`, or `undefined` if the walk leaves a container before the end. */
export function getAtPath(value: unknown, path: PathSegment[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (!isContainer(current)) return undefined
    current = childAt(current, segment)
  }
  return current
}

/** Sets the value at `path` to `undefined` in place, doing nothing when a parent is missing. */
export function setUndefinedAtPath(value: unknown, path: PathSegment[]): void {
  if (path.length === 0) return
  const parent = getAtPath(value, path.slice(0, -1))
  if (!isContainer(parent)) return
  ;(parent as Record<PathSegment, unknown>)[path[path.length - 1]] = undefined
}

/** True when `path` or one of its ancestors failed. */
export function failedAt(result: AnySettled, path: string): boolean {
  return result.failedPaths.some(failedPath => isPrefixPath(failedPath, path))
}

/** The errors whose path is `path` or lies under it. */
export function errorsAt(result: AnySettled, path: string): SettledError[] {
  return result.errors.filter(({ path: errorPath }) => errorPath !== undefined && isPrefixPath(path, pathToString(errorPath)))
}
