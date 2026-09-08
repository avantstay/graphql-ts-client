import { errorsAt, failedAt, getAtPath, isPrefixPath, parsePath, pathToString, setUndefinedAtPath } from './paths'
import { AnySettled } from './types'

describe('paths', () => {
  it('round-trips path strings with numeric segments', () => {
    expect(pathToString(['rooms', 0, 'beds'])).toBe('rooms.0.beds')
    expect(parsePath('rooms.0.beds')).toEqual(['rooms', 0, 'beds'])
    expect(parsePath('')).toEqual([])
  })

  it('isPrefixPath matches whole segments only', () => {
    expect(isPrefixPath('rooms', 'rooms.0')).toBe(true)
    expect(isPrefixPath('rooms', 'rooms')).toBe(true)
    expect(isPrefixPath('room', 'rooms')).toBe(false)
  })

  it('setUndefinedAtPath sets the leaf and ignores missing parents', () => {
    const value: any = { user: { rooms: [{ beds: 2 }] } }
    setUndefinedAtPath(value, ['user', 'rooms', 0, 'beds'])
    expect(value.user.rooms[0]).toEqual({ beds: undefined })
    setUndefinedAtPath(value, ['missing', 'leaf'])
    expect(getAtPath(value, ['missing'])).toBeUndefined()
  })

  it('failedAt and errorsAt look under a path', () => {
    const result = {
      outcome: 'partial',
      data: {},
      errors: [{ message: 'x', path: ['stats', 'posts'], redacted: false }],
      failedPaths: ['stats.posts'],
      warnings: [],
      codes: [],
      requestIds: [],
    } as AnySettled
    expect(failedAt(result, 'stats.posts.count')).toBe(true)
    expect(failedAt(result, 'stats')).toBe(false)
    expect(errorsAt(result, 'stats')).toHaveLength(1)
    expect(errorsAt(result, 'id')).toHaveLength(0)
  })
})
