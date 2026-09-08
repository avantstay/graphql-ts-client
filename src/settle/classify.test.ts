import { applyFailedPaths, classify, toSettled } from './classify'

const operation = { kind: 'query' as const, alias: 'user' }
const base = { warnings: undefined, httpStatus: 200, operation }

describe('classify', () => {
  it('success when there are no errors', () => {
    const result = classify({ ...base, data: { id: 'user_1' }, errors: [] })
    expect(result).toMatchObject({ outcome: 'success', failedPaths: [], codes: [], requestIds: [] })
  })

  it('partial when a nullable field failed; the path is relative to the root field', () => {
    const errors = [
      { message: 'Service unavailable', path: ['user', 'stats'], extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'r1' } },
    ]
    const result = classify({ ...base, data: { id: 'user_1', stats: null }, errors })
    expect(result).toMatchObject({
      outcome: 'partial',
      failedPaths: ['stats'],
      codes: ['SERVICE_UNAVAILABLE'],
      requestIds: ['r1'],
    })
    expect(result.failedSegments).toEqual([['stats']])
  })

  it('strips an alias root instead of the field name', () => {
    const errors = [{ message: 'x', path: ['myUser', 'stats'] }]
    const result = classify({ ...base, operation: { ...operation, alias: 'myUser' }, data: { stats: null }, errors })
    expect(result.failedPaths).toEqual(['stats'])
  })

  it('reports the ancestor the server nulled, not the deep field in the error', () => {
    const errors = [{ message: 'x', path: ['user', 'stats', 'posts', 'count'] }]
    const result = classify({ ...base, data: { id: 'user_1', stats: null }, errors })
    expect(result).toMatchObject({ outcome: 'partial', failedPaths: ['stats'] })
    expect(result.failedSegments).toEqual([['stats']])
  })

  it('fails with no-data on null data, a lost root, or http on status >= 400', () => {
    expect(classify({ ...base, data: { id: 'user_1' }, errors: [{ message: 'x', path: ['user'] }] })).toMatchObject({
      outcome: 'failure',
      reason: 'no-data',
    })
    expect(classify({ ...base, data: null, errors: [{ message: 'boom' }] })).toMatchObject({
      outcome: 'failure',
      reason: 'no-data',
    })
    expect(classify({ ...base, httpStatus: 500, data: undefined, errors: [] })).toMatchObject({
      outcome: 'failure',
      reason: 'http',
    })
  })

  it('fails with no-data on a path-less error when data is null, and stays partial otherwise', () => {
    expect(
      classify({ ...base, data: null, errors: [{ message: 'x', extensions: { code: 'SUBREQUEST_HTTP_ERROR' } }] })
    ).toMatchObject({ reason: 'no-data' })
    expect(
      classify({ ...base, data: { id: 'user_1' }, errors: [{ message: 'x', extensions: { code: 'SUBREQUEST_HTTP_ERROR' } }] })
    ).toMatchObject({ outcome: 'partial', failedPaths: [] })
  })

  it('fails with required-path when a required path or its ancestor or descendant failed', () => {
    const errors = [{ message: 'x', path: ['user', 'stats'] }]
    expect(classify({ ...base, data: { stats: null }, errors, require: ['stats.posts'] })).toMatchObject({
      outcome: 'failure',
      reason: 'required-path',
    })
    expect(classify({ ...base, data: { stats: null }, errors, require: ['id'] })).toMatchObject({ outcome: 'partial' })
  })

  it('dedupes codes but keeps a requestId per error, falling back to the legacy errorId', () => {
    const errors = [
      { message: 'x', extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'r1' } },
      { message: 'y', extensions: { code: 'SERVICE_UNAVAILABLE', errorId: 'r2' } },
    ]
    const result = classify({ ...base, data: { id: 'user_1' }, errors })
    expect(result.codes).toEqual(['SERVICE_UNAVAILABLE'])
    expect(result.requestIds).toEqual(['r1', 'r2'])
  })

  it('reads warnings from extensions first, then legacy', () => {
    expect(classify({ ...base, data: {}, errors: [], warnings: [{ message: 'w', code: 'W1' }] }).warnings).toEqual([
      { message: 'w', code: 'W1' },
    ])
    expect(classify({ ...base, data: {}, errors: [], warnings: 'nope' }).warnings).toEqual([])
  })

  it('keeps the error path when nothing along it is null', () => {
    const errors = [{ message: 'x', path: ['user', 'stats', 'posts', 'count'] }]
    const result = classify({ ...base, data: { stats: { posts: { count: 0 } } }, errors })
    expect(result).toMatchObject({ outcome: 'partial', failedPaths: ['stats.posts.count'] })
  })
})

describe('applyFailedPaths and toSettled', () => {
  it('sets failed paths to undefined and leaves legitimate nulls alone', () => {
    const data: any = { id: 'user_1', stats: null, description: null }
    applyFailedPaths(data, [['stats']])
    expect(data).toEqual({ id: 'user_1', stats: undefined, description: null })
    expect('stats' in data).toBe(true)
  })

  it('builds a branded settled response', () => {
    const classification = classify({ ...base, data: { id: 'user_1' }, errors: [] })
    const settled = toSettled({ id: 'user_1' }, classification, 200)
    expect(settled).toMatchObject({ outcome: 'success', data: { id: 'user_1' }, httpStatus: 200 })
    expect(Object.keys(settled)).not.toContain('reason')
    expect((settled as any)[Symbol.for('@avantstay/graphql-ts-client/settled')]).toBe(true)
    const failed = toSettled(null, classify({ ...base, data: null, errors: [{ message: 'x' }] }), 200)
    expect(failed).toMatchObject({ outcome: 'failure', reason: 'no-data', data: null })
  })
})
