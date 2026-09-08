import axios from 'axios'
import { getApiEndpointCreator } from './endpoint'
import { isSettled } from './settle/types'
import { MutationEndpoint } from './types'

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
const createEndpoint = getApiEndpointCreator({
  getClient: () => ({ url: 'https://example.invalid/graphql', headers: {}, retryConfig: { max: 0, before: () => undefined } }),
  requestListeners: [],
  responseListeners: [responseListener],
  typesTree,
  maxAge: 30000,
  verbose: false,
  formatGraphQL: (query: string) => query,
})
const user = createEndpoint<any, any, any>('query', 'user')
const updateUser = createEndpoint<any, any, any>('mutation', 'updateUser')

const partialBody = {
  data: { user: { id: 'user_1', stats: null } },
  errors: [{ message: 'Service unavailable', path: ['user', 'stats'], extensions: { code: 'SERVICE_UNAVAILABLE' } }],
}

afterEach(() => jest.restoreAllMocks())

describe('raw()', () => {
  it('returns the untouched data plus outcome fields', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, headers: {}, data: partialBody })
    const result = await user.raw({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    expect(result.data).toEqual({ id: 'user_1', stats: null })
    expect(result).toMatchObject({ status: 200, outcome: 'partial', failedPaths: ['stats'], codes: ['SERVICE_UNAVAILABLE'] })
    expect(isSettled(result)).toBe(false)
  })

  it('passes __require through and fails on a required path', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, headers: {}, data: partialBody })
    const result = await user.raw({ __args: { id: 'user_1' }, __require: ['stats'], id: true, stats: { score: true } })
    expect(result).toMatchObject({ outcome: 'failure', reason: 'required-path' })
  })
})

describe('settle()', () => {
  it('returns a branded union with normalised data', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, headers: {}, data: partialBody })
    const result = await user.settle({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    expect(isSettled(result)).toBe(true)
    expect(result).toMatchObject({ outcome: 'partial', failedPaths: ['stats'], httpStatus: 200 })
    expect(result.data).toEqual({ id: 'user_1', stats: undefined })
  })

  it('never throws on failure', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 500, headers: {}, data: {} })
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
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, headers: {}, data: partialBody })
    responseListener.mockClear()
    const result = await user.settle({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(responseListener).toHaveBeenCalledWith(
      expect.objectContaining({ response: expect.objectContaining({ data: { user: { id: 'user_1', stats: null } } }) })
    )
    expect(result.data).toEqual({ id: 'user_1', stats: undefined })
  })

  it('blocks a mutation whose source is partial without sending', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, headers: {}, data: partialBody })
    const source = await user.settle({ __args: { id: 'user_1' }, id: true, stats: { score: true } })
    post.mockClear()
    const result = await updateUser.settle({ __sources: [source], __args: { input: {} }, id: true })
    expect(post).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: 'failure', reason: 'partial-source', failedPaths: ['stats'] })
  })

  it('sends a mutation when sources succeeded or are explicitly none', async () => {
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 200, headers: {}, data: { data: { updateUser: { id: 'user_1' } } } })
    await expect(updateUser.settle({ __sources: { none: 'create form' }, id: true })).resolves.toMatchObject({
      outcome: 'success',
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('throws MissingSourcesError for an empty array or blank reason on a mutation', async () => {
    await expect(updateUser.settle({ __sources: [], id: true })).rejects.toThrow(/sources/)
    await expect(updateUser.settle({ __sources: { none: '  ' }, id: true })).rejects.toThrow(/sources/)
    await expect(updateUser.settle({ id: true } as any)).rejects.toThrow(/sources/)
  })

  it('strips __require and __sources from the document', async () => {
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 200, headers: {}, data: { data: { user: { id: 'user_1' } } } })
    await user.settle({ __args: { id: 'user_1' }, __require: ['id'], id: true })
    const [, body] = post.mock.calls[0] as [string, { query: string }]
    expect(body.query).not.toMatch(/__require|__sources/)
  })
})

describe('response listeners and memo', () => {
  it('gives listeners outcome and failedPaths', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, headers: {}, data: partialBody })
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
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({ status: 200, headers: {}, data: partialBody })
      .mockResolvedValue({ status: 200, headers: {}, data: { data: { user: { id: 'user_1', stats: { score: 5 } } } } })
    const selection = { __args: { id: 'memo' }, id: true, stats: { score: true } }
    expect((await user.memoRaw(selection)).outcome).toBe('partial')
    expect((await user.memoRaw(selection)).outcome).toBe('success')
    expect((await user.memoRaw(selection)).outcome).toBe('success')
    expect(post).toHaveBeenCalledTimes(2)
  })
})

describe('MutationEndpoint type', () => {
  it('stays callable as a function (compile-time check)', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, headers: {}, data: { data: { updateUser: { id: 'user_1' } } } })
    // If MutationEndpoint's call signature were ever dropped (e.g. by building it with `Omit<Endpoint<...>, ...>`,
    // a mapped type that strips call signatures), this line would fail to typecheck under `tsc --noEmit`.
    const typed: MutationEndpoint<any, any, any> = updateUser as any
    await typed({ id: true })
    expect(typeof typed).toBe('function')
  })
})
