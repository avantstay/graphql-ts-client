import { isContainer } from './paths'
import { PathSegment } from './types'

export type ResolvedFailedPath = { path: PathSegment[] | 'root' }

/**
 * Walks `path` (relative to the root field's value) through `data` and returns the shortest prefix
 * whose value is null or missing: that is where the server bubbled the failure. A path that never
 * meets a null is returned as received. A null root value, non-container root, or empty path returns 'root'.
 */
export function resolveFailedPath(data: unknown, path: PathSegment[]): ResolvedFailedPath {
  if (!isContainer(data) || path.length === 0) return { path: 'root' }
  let current: unknown = data
  for (let index = 0; index < path.length; index += 1) {
    if (!isContainer(current)) return { path: path.slice(0, index) }
    const next = (current as Record<string, unknown>)[path[index] as string]
    if (next === null || next === undefined) return { path: path.slice(0, index + 1) }
    current = next
  }
  return { path }
}
