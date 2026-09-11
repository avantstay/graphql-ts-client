import axios from 'axios'
import { isSettled } from './settle/types'
import { createTestEndpointCreator } from './testSupport/endpointFixture'
import { MissingSourcesError, MutationEndpoint } from './types'

const typesTree: any = {}
typesTree.Stats = {}
typesTree.User = {
  get stats() {
    return { __fields: typesTree.Stats }
  },
}
typesTree.Query = {
  get user() {
    return { __fields: typesTree.User, __args: { id: 'ID!' } }
  },
}
typesTree.Mutation = {
  get updateUser() {
    return { __fields: typesTree.User }
  },
}

const responseListener = jest.fn()
const createEndpoint = createTestEndpointCreator({ responseListeners: [responseListener], typesTree, maxAge: 30000 })
const user = createEndpoint<any, any, any>('query', 'user')
const updateUser = createEndpoint<any, any, any>('mutation', 'updateUser')

const partialBody = {
  data: { user: { id: 'user_1', stats: null } },
  errors: [{ message: 'Service unavailable', path: ['user', 'stats'], extensions: { code: 'SERVICE_UNAVAILABLE' } }],
}

function mockPost(data: unknown, status = 200) {
  return jest.spyOn(axios, 'post').mockResolvedValue({ status, headers: {}, data } as never)
}

afterEach(() => jest.restoreAllMocks())

describe('raw()', () => {
  it('returns the untouched data plus outcome fields', async () => {
    mockPost(partialBody)
    const result = await user.raw({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    expect(result.data).toEqual({ id: 'user_1', stats: null })
    expect(result).toMatchObject({ status: 200, outcome: 'partial', failedPaths: ['stats'] })
    expect(result.errors).toEqual(partialBody.errors)
    expect(isSettled(result)).toBe(false)
  })
})

describe('settle()', () => {
  it('returns a branded union with normalised data', async () => {
    mockPost(partialBody)
    const result = await user.settle({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    expect(isSettled(result)).toBe(true)
    expect(result).toMatchObject({ outcome: 'partial', failedPaths: ['stats'], status: 200 })
    expect(result.data).toEqual({ id: 'user_1', stats: undefined })
  })

  it('never throws on failure', async () => {
    mockPost({}, 500)
    await expect(user.settle({ __args: { id: 'user_1' }, id: true })).resolves.toMatchObject({
      outcome: 'failure',
      reason: 'http',
      data: null,
    })
  })

  it('never throws on a transport failure (e.g. a network error)', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('Network Error'))
    await expect(user.settle({ __args: { id: 'user_1' }, id: true })).resolves.toMatchObject({
      outcome: 'failure',
      reason: 'http',
      errors: [{ message: 'Network Error' }],
    })
  })

  it('does not mutate the data already handed to response listeners', async () => {
    mockPost(partialBody)
    responseListener.mockClear()
    const result = await user.settle({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(responseListener).toHaveBeenCalledWith(
      expect.objectContaining({ response: expect.objectContaining({ data: { user: { id: 'user_1', stats: null } } }) })
    )
    expect(result.data).toEqual({ id: 'user_1', stats: undefined })
  })

  it('blocks a mutation whose source is partial without sending, carrying its errors and warnings', async () => {
    const post = mockPost({
      ...partialBody,
      extensions: { warnings: [{ message: 'Serving a stale cache', code: 'STALE_CACHE' }] },
    })
    const source = await user.settle({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    expect(source.warnings).toEqual([{ message: 'Serving a stale cache', code: 'STALE_CACHE' }])
    post.mockClear()
    const result = await updateUser.settle({ __settledSources: [source], __args: { input: {} }, id: true })
    expect(post).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: 'failure', reason: 'partial-source', failedPaths: ['stats'] })
    expect(result.errors).toEqual(source.errors)
    expect(result.warnings).toEqual([{ message: 'Serving a stale cache', code: 'STALE_CACHE' }])
  })

  it('sends a mutation when sources succeeded or are explicitly none', async () => {
    const post = mockPost({ data: { updateUser: { id: 'user_1' } } })
    await expect(updateUser.settle({ __settledSources: 'none', id: true })).resolves.toMatchObject({
      outcome: 'success',
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('throws MissingSourcesError for an empty array, a missing or an unrecognised __settledSources', async () => {
    await expect(updateUser.settle({ __settledSources: [], id: true })).rejects.toThrow(MissingSourcesError)
    await expect(updateUser.settle({ __settledSources: 'nope' as any, id: true })).rejects.toThrow(MissingSourcesError)
    await expect(updateUser.settle({ id: true } as any)).rejects.toThrow(MissingSourcesError)
  })

  it('throws MissingSourcesError when a source did not come from settle()', async () => {
    await expect(updateUser.settle({ __settledSources: [{ data: { a: 1 } } as any], id: true })).rejects.toThrow(
      MissingSourcesError
    )
  })

  it('strips __settledSources from the document', async () => {
    const post = mockPost({ data: { updateUser: { id: 'user_1' } } })
    await updateUser.settle({ __settledSources: 'none', id: true })
    const [, body] = post.mock.calls[0] as [string, { query: string }]
    expect(body.query).not.toMatch(/__/)
  })
})

describe('call options', () => {
  it('keeps every __ option out of the document while still honouring it', async () => {
    const post = mockPost({ data: { aliasedUser: { id: 'user_1' } } })
    const result = await user.raw({
      __args: { id: 'user_1' },
      __alias: 'aliasedUser',
      __retry: false,
      __headers: { 'x-call-option': 'sent' },
      __url: 'https://example.invalid/custom-graphql',
      id: true,
    })
    const [requestUrl, body, requestConfig] = post.mock.calls[0] as [
      string,
      { query: string },
      { headers: Record<string, string> }
    ]
    expect(body.query).not.toMatch(/__/)
    expect(body.query).toBe('query aliasedUser($id: ID!) { aliasedUser:user(id:$id) { id } }')
    expect(requestUrl).toBe('https://example.invalid/custom-graphql')
    expect(requestConfig.headers).toMatchObject({ 'x-call-option': 'sent' })
    expect(result.data).toEqual({ id: 'user_1' })
  })

  it('drops an unknown __ option but keeps __typename, a real GraphQL meta-field', async () => {
    const post = mockPost({ data: { user: { __typename: 'User', id: 'user_1' } } })
    await user.raw({ __args: { id: 'user_1' }, __someFutureOption: ['stats'], __typename: true, id: true } as any)
    const [, body] = post.mock.calls[0] as [string, { query: string }]
    expect(body.query).toBe('query user($id: ID!) { user(id:$id) { __typename id } }')
  })
})

describe('response listeners and memo', () => {
  it('gives listeners outcome and failedPaths', async () => {
    mockPost(partialBody)
    responseListener.mockClear()
    await user.raw({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(responseListener).toHaveBeenCalledWith(
      expect.objectContaining({
        queryName: 'user',
        response: expect.objectContaining({ outcome: 'partial', failedPaths: ['stats'] }),
      })
    )
  })

  it('memoRaw caches success only', async () => {
    const post = mockPost({ data: { user: { id: 'user_1', stats: { score: 5 } } } }).mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: partialBody,
    } as never)
    const selection = { __args: { id: 'memo' }, id: true, stats: { score: true } }
    expect((await user.memoRaw(selection)).outcome).toBe('partial')
    expect((await user.memoRaw(selection)).outcome).toBe('success')
    expect((await user.memoRaw(selection)).outcome).toBe('success')
    expect(post).toHaveBeenCalledTimes(2)
  })
})

describe('MutationEndpoint type', () => {
  it('stays callable as a function (compile-time check)', async () => {
    mockPost({ data: { updateUser: { id: 'user_1' } } })
    const typed: MutationEndpoint<any, any, any> = updateUser as any
    await typed({ id: true })
    expect(typeof typed).toBe('function')
  })
})
