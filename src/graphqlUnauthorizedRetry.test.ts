import axios from 'axios'
import { graphqlRequest, GraphqlRequestOptions } from './graphqlRequest'
import { clientWithRetries } from './testSupport/clientConfig'
import { createTestEndpointCreator } from './testSupport/endpointFixture'
import { ClientConfig, RequestListenerInfo } from './types'

function recordingAxios(responses: Array<{ status: number; data?: unknown }>) {
  const sentHeaders: Array<Record<string, string>> = []
  const fake = {
    post: async (_url: string, _body: unknown, options: { headers: Record<string, string> }) => {
      sentHeaders.push(options.headers)
      return responses[Math.min(sentHeaders.length - 1, responses.length - 1)]
    },
  } as any
  return { axios: fake, sentHeaders }
}

const unauthorized = { status: 401, data: { errors: [{ message: 'unauthorized request' }] } }
const ok = (root: string) => ({ status: 200, data: { data: { [root]: { id: 'user_1' } } } })

function withUnauthorizedRetry(max = 0, extra: Partial<ClientConfig['retryConfig']> = {}): ClientConfig {
  const client = clientWithRetries(max)
  return { ...client, retryConfig: { ...client.retryConfig, unauthorized: true, ...extra } }
}

const common: Pick<GraphqlRequestOptions, 'query' | 'variables' | 'failureMode'> = {
  query: 'query user { user { id } }',
  variables: {},
  failureMode: 'silent',
}

describe('retrying a 401', () => {
  it('retries a 401 once with the headers prepared for the retry', async () => {
    const { axios: fake, sentHeaders } = recordingAxios([unauthorized, ok('user')])
    const prepareRetryHeaders = jest.fn(async () => ({ Authorization: 'Bearer new' }))

    const result = await graphqlRequest({
      ...common,
      kind: 'query',
      queryName: 'user',
      axios: fake,
      client: withUnauthorizedRetry(),
      requestHeaders: { Authorization: 'Bearer expired' },
      prepareRetryHeaders,
    })

    expect(result.status).toBe(200)
    expect(sentHeaders.map(headers => headers.Authorization)).toEqual(['Bearer expired', 'Bearer new'])
    expect(prepareRetryHeaders).toHaveBeenCalledWith({
      trial: 1,
      previousResponse: expect.objectContaining({ status: 401 }),
    })
  })

  it('retries a 401 for a mutation too, because the server never ran it', async () => {
    const { axios: fake, sentHeaders } = recordingAxios([unauthorized, ok('updateUser')])

    const result = await graphqlRequest({
      ...common,
      kind: 'mutation',
      queryName: 'updateUser',
      axios: fake,
      client: withUnauthorizedRetry(),
      prepareRetryHeaders: async () => ({ Authorization: 'Bearer new' }),
    })

    expect(result.status).toBe(200)
    expect(sentHeaders).toHaveLength(2)
  })

  it('retries a 401 only once', async () => {
    const { axios: fake, sentHeaders } = recordingAxios([unauthorized, unauthorized, ok('user')])

    const result = await graphqlRequest({
      ...common,
      kind: 'query',
      queryName: 'user',
      axios: fake,
      client: withUnauthorizedRetry(),
    })

    expect(result.status).toBe(401)
    expect(sentHeaders).toHaveLength(2)
  })

  it('does not retry a 401 unless the client enables it', async () => {
    const { axios: fake, sentHeaders } = recordingAxios([unauthorized, ok('updateUser')])

    const result = await graphqlRequest({
      ...common,
      kind: 'mutation',
      queryName: 'updateUser',
      axios: fake,
      client: clientWithRetries(2),
    })

    expect(result.status).toBe(401)
    expect(sentHeaders).toHaveLength(1)
  })

  it('does not spend the error retries on a 401, and refreshes headers for every retry', async () => {
    const { axios: fake, sentHeaders } = recordingAxios([unauthorized, { status: 500 }, ok('user')])
    let issued = 0

    const result = await graphqlRequest({
      ...common,
      kind: 'query',
      queryName: 'user',
      axios: fake,
      client: withUnauthorizedRetry(1),
      requestHeaders: { Authorization: 'Bearer 0' },
      prepareRetryHeaders: async () => ({ Authorization: `Bearer ${++issued}` }),
    })

    expect(result.status).toBe(200)
    expect(sentHeaders.map(headers => headers.Authorization)).toEqual(['Bearer 0', 'Bearer 1', 'Bearer 2'])
  })
})

describe('request listeners on retries', () => {
  afterEach(() => jest.restoreAllMocks())

  it('run before every attempt, so a 401 retry carries the token the listener issues for it', async () => {
    const seen: RequestListenerInfo[] = []
    const listener = async (info: RequestListenerInfo) => {
      seen.push(info)
      info.headers.Authorization = info.retry ? 'Bearer refreshed' : 'Bearer cached'
    }
    jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({ ...unauthorized, headers: {} })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: { updateUser: { id: 'user_1' } } } })
    const endpoint = createTestEndpointCreator({
      requestListeners: [listener],
      getClient: () => ({
        url: 'https://example.invalid/graphql',
        headers: {},
        retryConfig: { max: 0, before: () => undefined, unauthorized: true },
      }),
    })('mutation', 'updateUser')

    const response = await endpoint.raw({ id: true } as any)

    expect(response.status).toBe(200)
    expect(seen.map(info => info.retry?.trial)).toEqual([undefined, 1])
    expect(seen[1].retry?.previousResponse.status).toBe(401)
    const sent = (axios.post as jest.Mock).mock.calls.map(call => call[2].headers.Authorization)
    expect(sent).toEqual(['Bearer cached', 'Bearer refreshed'])
  })
})
