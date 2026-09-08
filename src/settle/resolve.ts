import { childAt, isContainer } from './paths'
import { PathSegment } from './types'

/** The shortest prefix of `path` that is null or missing in `data` — where the server bubbled the failure — or `'root'`. */
export function resolveFailedPath(data: unknown, path: PathSegment[]): PathSegment[] | 'root' {
  if (!isContainer(data) || path.length === 0) return 'root'
  let current: unknown = data
  for (let index = 0; index < path.length; index += 1) {
    if (!isContainer(current)) return path.slice(0, index)
    const next = childAt(current, path[index])
    if (next === null || next === undefined) return path.slice(0, index + 1)
    current = next
  }
  return path
}
