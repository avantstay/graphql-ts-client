import { resolveFailedPath } from './resolve'

describe('resolveFailedPath', () => {
  it('keeps the path when the failed leaf itself is null', () => {
    expect(resolveFailedPath({ id: 'user_1', stats: null }, ['stats'])).toEqual({ path: ['stats'] })
  })

  it('truncates at the ancestor the server nulled', () => {
    expect(resolveFailedPath({ stats: null }, ['stats', 'posts', 'count'])).toEqual({ path: ['stats'] })
    expect(resolveFailedPath({ stats: { posts: null } }, ['stats', 'posts', 'count'])).toEqual({ path: ['stats', 'posts'] })
  })

  it('handles list indexes', () => {
    expect(resolveFailedPath({ rooms: [{ beds: null }] }, ['rooms', 0, 'beds', 1, 'size'])).toEqual({
      path: ['rooms', 0, 'beds'],
    })
    expect(resolveFailedPath({ rooms: [null] }, ['rooms', 0, 'beds'])).toEqual({ path: ['rooms', 0] })
  })

  it('reports root when the root value itself is gone', () => {
    expect(resolveFailedPath(null, ['stats'])).toEqual({ path: 'root' })
    expect(resolveFailedPath({ stats: {} }, [])).toEqual({ path: 'root' })
    expect(resolveFailedPath('scalar', ['stats'])).toEqual({ path: 'root' })
  })

  it('keeps the path as received when nothing along it is null', () => {
    expect(resolveFailedPath({ stats: { posts: { count: 3 } } }, ['stats', 'posts', 'count'])).toEqual({
      path: ['stats', 'posts', 'count'],
    })
  })
})
