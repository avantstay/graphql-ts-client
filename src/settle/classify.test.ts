import { applyFailedPaths, classify, toSettled } from './classify'

const base = { warnings: undefined, status: 200, rootName: 'user' }

describe('classify', () => {
  it('success when there are no errors', () => {
    const result = classify({ ...base, data: { id: 'user_1' }, errors: [] })
    expect(result).toMatchObject({ outcome: 'success', failedPaths: [] })
  })

  it('partial when a nullable field failed; the path is relative to the root field', () => {
    const errors = [
      { message: 'Service unavailable', path: ['user', 'stats'], extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'r1' } },
    ]
    const result = classify({ ...base, data: { id: 'user_1', stats: null }, errors })
    expect(result).toMatchObject({
      outcome: 'partial',
      failedPaths: ['stats'],
      errors: [expect.objectContaining({ extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'r1' } })],
    })
    expect(result.failedSegments).toEqual([['stats']])
  })

  it('strips an alias root instead of the field name', () => {
    const errors = [{ message: 'x', path: ['myUser', 'stats'] }]
    const result = classify({ ...base, rootName: 'myUser', data: { stats: null }, errors })
    expect(result.failedPaths).toEqual(['stats'])
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
    expect(classify({ ...base, status: 500, data: undefined, errors: [] })).toMatchObject({
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

  it('keeps every error, so codes and request ids stay readable from extensions', () => {
    const errors = [
      { message: 'x', extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'r1' } },
      { message: 'y', extensions: { code: 'SERVICE_UNAVAILABLE', errorId: 'r2' } },
    ]
    const result = classify({ ...base, data: { id: 'user_1' }, errors })
    expect(result.errors.map(error => error.extensions?.code)).toEqual(['SERVICE_UNAVAILABLE', 'SERVICE_UNAVAILABLE'])
    expect(result.errors.map(error => error.extensions?.requestId ?? error.extensions?.errorId)).toEqual(['r1', 'r2'])
  })

  it('normalises warnings and drops non-array values', () => {
    expect(classify({ ...base, data: {}, errors: [], warnings: [{ message: 'w', code: 'W1' }] }).warnings).toEqual([
      { message: 'w', code: 'W1' },
    ])
    expect(classify({ ...base, data: {}, errors: [], warnings: 'nope' }).warnings).toEqual([])
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
    expect(settled).toMatchObject({ outcome: 'success', data: { id: 'user_1' }, status: 200 })
    expect(Object.keys(settled)).not.toContain('reason')
    expect((settled as any)[Symbol.for('@avantstay/graphql-ts-client/settled')]).toBe(true)
    const failed = toSettled(null, classify({ ...base, data: null, errors: [{ message: 'x' }] }), 200)
    expect(failed).toMatchObject({ outcome: 'failure', reason: 'no-data', data: null })
  })
})
