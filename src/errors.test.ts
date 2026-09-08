import { GraphQLClientError, MissingSourcesError } from './types'

// tsup emits src/index.ts and src/endpoint.ts as two independent bundles, each carrying its own copy of
// these classes: an error thrown from one bundle has a prototype from that copy, not from the copy the
// consumer imported. Detaching the prototype simulates exactly that — a plain prototype-chain `instanceof`
// would be false, and only the Symbol.for brand can still recognise it.
function asForeignCopy<E extends Error>(error: E): E {
  Object.setPrototypeOf(error, Error.prototype)
  return error
}

describe('cross-bundle instanceof', () => {
  it('recognises a GraphQLClientError whose prototype comes from another copy of the class', () => {
    const error = asForeignCopy(new GraphQLClientError({ data: null, warnings: [], headers: {}, errors: [{ message: 'x' }] }))

    expect(Object.getPrototypeOf(error)).toBe(Error.prototype)
    expect(error instanceof GraphQLClientError).toBe(true)
  })

  it('recognises a MissingSourcesError whose prototype comes from another copy of the class', () => {
    const error = asForeignCopy(new MissingSourcesError())

    expect(Object.getPrototypeOf(error)).toBe(Error.prototype)
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

  it('keeps the brand off enumeration', () => {
    const error = new MissingSourcesError()

    expect(Object.keys(error)).not.toContain(Symbol.for('@avantstay/graphql-ts-client/MissingSourcesError'))
    expect(Object.getOwnPropertySymbols(error)).toContain(Symbol.for('@avantstay/graphql-ts-client/MissingSourcesError'))
    expect(JSON.stringify({ ...error })).toBe('{}')
  })
})
