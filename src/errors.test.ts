import { GraphQLClientError, MissingSourcesError } from './types'

// Detaching the prototype simulates an error thrown from the other tsup bundle, where only the brand can identify it.
function asForeignCopy<E extends Error>(error: E): E {
  Object.setPrototypeOf(error, Error.prototype)
  return error
}

describe('cross-bundle instanceof', () => {
  it('recognises a GraphQLClientError whose prototype comes from another copy of the class', () => {
    const error = asForeignCopy(new GraphQLClientError({ data: null, warnings: [], headers: {}, errors: [{ message: 'x' }] }))

    expect(error instanceof GraphQLClientError).toBe(true)
  })

  it('recognises a MissingSourcesError whose prototype comes from another copy of the class', () => {
    const error = asForeignCopy(new MissingSourcesError())

    expect(error instanceof MissingSourcesError).toBe(true)
  })

  it('still recognises a normally constructed error', () => {
    expect(new MissingSourcesError() instanceof MissingSourcesError).toBe(true)
    expect(new GraphQLClientError({ data: null, warnings: [], headers: {}, errors: [] }) instanceof GraphQLClientError).toBe(true)
  })

  it('does not claim unrelated values or the other error class', () => {
    expect(new Error('plain') instanceof GraphQLClientError).toBe(false)
    expect(new MissingSourcesError() instanceof GraphQLClientError).toBe(false)
    expect(new GraphQLClientError({ data: null, warnings: [], headers: {}, errors: [] }) instanceof MissingSourcesError).toBe(
      false
    )
    expect((null as unknown) instanceof GraphQLClientError).toBe(false)
    expect({} instanceof MissingSourcesError).toBe(false)
  })

  it('names itself, so a logged error is not an anonymous Error', () => {
    expect(String(new MissingSourcesError()).startsWith('MissingSourcesError:')).toBe(true)
    expect(new GraphQLClientError({ data: null, warnings: [], headers: {}, errors: [] }).name).toBe('GraphQLClientError')
  })

  it('keeps the brand off enumeration', () => {
    const error = new MissingSourcesError()

    expect(Object.keys(error)).not.toContain(Symbol.for('@avantstay/graphql-ts-client/MissingSourcesError'))
    expect(Object.getOwnPropertySymbols(error)).toContain(Symbol.for('@avantstay/graphql-ts-client/MissingSourcesError'))
    expect(JSON.stringify({ ...error })).toBe('{}')
  })
})
