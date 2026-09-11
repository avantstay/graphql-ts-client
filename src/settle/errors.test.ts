import { normalizeErrors, REDACTED_MESSAGE } from './errors'

describe('normalizeErrors', () => {
  it('strips the root field from paths and dedupes identical errors', () => {
    const errors = normalizeErrors(
      [
        { message: 'Service unavailable', path: ['user', 'stats'], extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'r1' } },
        { message: 'Service unavailable', path: ['user', 'stats'], extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'r1' } },
        { message: REDACTED_MESSAGE },
        'not an error',
      ],
      'user'
    )
    expect(errors).toHaveLength(2)
    expect(errors[0].path).toEqual(['stats'])
    expect(errors[0].extensions?.code).toBe('SERVICE_UNAVAILABLE')
    expect(errors[1]).toMatchObject({ path: undefined, redacted: true })
  })

  it('keeps paths that do not start with the root name', () => {
    expect(normalizeErrors([{ message: 'x', path: ['other', 'field'] }], 'user')[0].path).toEqual(['other', 'field'])
  })

  it('returns an empty list for non-arrays', () => {
    expect(normalizeErrors(undefined, 'user')).toEqual([])
    expect(normalizeErrors({ message: 'x' }, 'user')).toEqual([])
  })
})
