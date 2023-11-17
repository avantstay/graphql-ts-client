import { jsonToGraphQLQuery } from './jsonToGraphQLQuery'

describe('jsonToGraphQLQuery', () => {
  it('use args without mutating', () => {
    const jsonQuery = {
      __args: {
        foo: 'Bar',
      },

      something: true,
    }

    const originalArgs = JSON.stringify(jsonQuery)

    const response = jsonToGraphQLQuery({
      kind: 'query',
      queryName: 'testing',
      jsonQuery,
      typesTree: {
        Query: {
          get testing(): any {
            return {
              __args: {
                foo: 'UUID!',
              },
            }
          },
        },
      },
    })

    expect(response).not.toBeNull()
    expect(originalArgs).toBe(JSON.stringify(jsonQuery))
  })

  it('variables are correctly named', () => {
    const jsonQuery = {
      __args: {
        foo: 'Bar',
      },
      something: true,
      another: {
        __args: {
          foo: 'Lorem ipsum',
          bar: 'Dolor sit amet',
        },
        zeta: true,
      },
    }

    const response = jsonToGraphQLQuery({
      kind: 'query',
      queryName: 'testing',
      jsonQuery,
      typesTree: {
        Query: {
          get testing(): any {
            return {
              __args: {
                foo: 'UUID!',
              },
              something: 'Boolean!',
              another: {
                __args: {
                  foo: 'String!',
                  bar: 'String!',
                },
                zeta: 'Int!',
              },
            }
          },
        },
      },
    })

    expect(response.variables).toEqual({
      foo_0: 'Bar',
      foo_1: 'Lorem ipsum',
      bar: 'Dolor sit amet',
    })
  })
})
