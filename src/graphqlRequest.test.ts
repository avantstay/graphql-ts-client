import { graphqlRequest } from './graphqlRequest'
import { clientWithRetries } from './testSupport/clientConfig'

describe('GraphQLRequest', () => {
  it('Should request have proper structure', async () => {
    let request: any

    const mockedAxios = {
      post: function () {
        request = arguments
        return {
          status: 200,
        }
      },
    } as any

    const result = await graphqlRequest({
      shouldRetry: false,
      failureMode: 'loud',
      axios: mockedAxios,
      kind: 'query',
      queryName: 'sampleQueryName',
      query: 'sampleQuery',
      variables: { foo: 'bar', bar: 'foo' },
      client: clientWithRetries(0),
    })

    expect(result.status).toBe(200)
    expect(request).toMatchSnapshot()
    const [url, data] = request
    expect(url).toEqual('https://example.invalid/graphql')
    expect(data.operationName).toEqual('sampleQueryName')
  })

  it('Should retry as many times as configured properly running a "before" hook', async () => {
    let retryCount = 0
    const maxRetrials = 2
    const mockedAxios = {
      post: async () => ({
        status: retryCount < maxRetrials ? 500 : 200,
      }),
    } as any

    const result = await graphqlRequest({
      failureMode: 'loud',
      axios: mockedAxios,
      kind: 'query',
      queryName: 'whatever',
      query: 'whatever',
      variables: {},
      requestHeaders: {},
      client: clientWithRetries(maxRetrials, { before: () => void retryCount++ }),
    })

    expect(retryCount).toBe(2)
    expect(result.status).toBe(200)
  })

  it('Should ignore default retrying config explicitly asking to skip retrials ', async () => {
    let retryCount = 0
    const maxRetrials = 2
    const mockedAxios = {
      post: async () => ({
        status: retryCount < maxRetrials ? 500 : 200,
      }),
    } as any

    await expect(
      graphqlRequest({
        shouldRetry: false,
        failureMode: 'loud',
        axios: mockedAxios,
        kind: 'query',
        queryName: 'whatever',
        query: 'whatever',
        variables: {},
        client: clientWithRetries(maxRetrials, { before: () => void retryCount++ }),
      })
    ).rejects.toBeInstanceOf(Error)
  })
})
