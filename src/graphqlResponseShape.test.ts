import axios from 'axios'
import { getApiEndpointCreator } from './endpoint'
import { graphqlRequest } from './graphqlRequest'
import { GraphQLClientError } from './types'

// The Arriere monolith moved `warnings` to `extensions.warnings` and each error's `code` and
// public fields to `errors[].extensions`. graphqlRequest restores the legacy top-level shape
// before anything else (errorsParser, retry hooks, response listeners, callers) sees it.

const legacyWarnings = [{ code: 'LEGACY', message: 'Legacy warning' }]
const extensionWarnings = [{ code: 'COUPON_DISABLED', message: 'Coupon is disabled' }]

const client = (retryConfig: { max: number; before: (info: any) => any }) => ({
  url: 'https://example.invalid/graphql',
  headers: {},
  retryConfig,
})

const requestOnce = (response: { status: number; data?: any }, options: Partial<Parameters<typeof graphqlRequest>[0]> = {}) =>
  graphqlRequest({
    shouldRetry: false,
    failureMode: 'silent',
    queryName: 'booking',
    query: 'query booking { booking }',
    variables: {},
    client: client({ max: 0, before: () => undefined }),
    axios: { post: jest.fn().mockResolvedValue({ headers: {}, ...response }) } as any,
    ...options,
  })

describe('warnings', () => {
  it.each([
    { name: 'legacy top-level warnings are kept', body: { warnings: legacyWarnings }, expected: legacyWarnings },
    { name: 'extension warnings are read', body: { extensions: { warnings: extensionWarnings } }, expected: extensionWarnings },
    {
      name: 'extension warnings win over legacy ones',
      body: { warnings: legacyWarnings, extensions: { warnings: extensionWarnings } },
      expected: extensionWarnings,
    },
    {
      name: 'an empty extension warnings array wins',
      body: { warnings: legacyWarnings, extensions: { warnings: [] } },
      expected: [],
    },
    { name: 'null extensions fall back to legacy', body: { warnings: legacyWarnings, extensions: null }, expected: legacyWarnings },
    {
      name: 'null extension warnings fall back to legacy',
      body: { warnings: legacyWarnings, extensions: { warnings: null } },
      expected: legacyWarnings,
    },
    {
      name: 'unrelated extensions fall back to legacy',
      body: { warnings: legacyWarnings, extensions: { tracing: {} } },
      expected: legacyWarnings,
    },
    { name: 'absent warnings stay absent', body: {}, expected: undefined },
  ])('$name', async ({ body, expected }) => {
    const response = await requestOnce({ status: 200, data: { data: { booking: null }, ...body } })

    expect(response.warnings).toEqual(expected)
    expect(response.data).toEqual({ booking: null })
  })
})

describe('errors', () => {
  it('lifts extensions.code and extensions.details to the top level and keeps extensions', async () => {
    const error = {
      message: 'Calendar is blocked',
      path: ['createBooking'],
      extensions: { code: 'CALENDAR_BLOCKED', details: { homeId: 'home-1', nights: 3 } },
    }

    const response = await requestOnce({ status: 200, data: { data: null, errors: [error] } })

    expect(response.errors).toEqual([
      {
        homeId: 'home-1',
        nights: 3,
        code: 'CALENDAR_BLOCKED',
        message: 'Calendar is blocked',
        path: ['createBooking'],
        extensions: { code: 'CALENDAR_BLOCKED', details: { homeId: 'home-1', nights: 3 } },
      },
    ])
    expect((response.errors[0] as any).extensions).toBe(error.extensions)
  })

  it('keeps fields already on the error over lifted ones', async () => {
    const error = {
      message: 'Top-level message',
      code: 'LEGACY_CODE',
      homeId: 'legacy-home',
      extensions: { code: 'CART_EXPIRED', details: { message: 'Details message', homeId: 'details-home', cartId: 'cart-1' } },
    }

    const response = await requestOnce({ status: 200, data: { data: null, errors: [error] } })

    expect(response.errors[0]).toEqual({ ...error, cartId: 'cart-1' })
  })

  it('lifts details without inventing a code and leaves errors without extensions alone', async () => {
    const plain = { message: 'No extensions' }
    const detailsOnly = { message: 'Details only', extensions: { details: { field: 'email' } } }

    const response = await requestOnce({ status: 200, data: { data: null, errors: [plain, detailsOnly, null] } })

    expect(response.errors[0]).toBe(plain)
    expect(response.errors[1]).toEqual({ field: 'email', ...detailsOnly })
    expect(response.errors[1]).not.toHaveProperty('code')
    expect(response.errors[2]).toBeNull()
  })

  it('does not mutate the response body', async () => {
    const error = { message: 'Cart expired', extensions: { code: 'CART_EXPIRED' } }

    await requestOnce({ status: 200, data: { data: null, errors: [error] } })

    expect(error).toEqual({ message: 'Cart expired', extensions: { code: 'CART_EXPIRED' } })
  })

  it('normalizes errors on a 422 that carries errors', async () => {
    const response = await requestOnce({
      status: 422,
      data: { errors: [{ message: 'Cart expired', extensions: { code: 'CART_EXPIRED' } }] },
    })

    expect(response.status).toBe(422)
    expect(response.errors).toEqual([{ code: 'CART_EXPIRED', message: 'Cart expired', extensions: { code: 'CART_EXPIRED' } }])
  })

  it('falls back to the synthetic message on a 500 without a body', async () => {
    const response = await requestOnce({ status: 500 })

    expect(response.errors).toEqual([{ message: 'Request "booking" failed with status 500' }])
    expect(response.warnings).toBeUndefined()
  })

  it('throws a GraphQLClientError carrying the normalized errors in loud mode', async () => {
    const error = await requestOnce(
      { status: 200, data: { data: null, errors: [{ message: 'Calendar is blocked', extensions: { code: 'CALENDAR_BLOCKED' } }] } },
      { failureMode: 'loud' }
    ).catch(e => e)

    expect(error).toBeInstanceOf(GraphQLClientError)
    expect(error.response.errors[0].code).toBe('CALENDAR_BLOCKED')
  })

  it('passes the normalized errors to errorsParser', async () => {
    const errorsParser = jest.fn((errors: any[]) => errors.map(e => e.code))

    const response = await requestOnce(
      { status: 200, data: { data: null, errors: [{ message: 'Cart expired', extensions: { code: 'CART_EXPIRED' } }] } },
      { errorsParser }
    )

    expect(errorsParser).toHaveBeenCalledWith([
      { code: 'CART_EXPIRED', message: 'Cart expired', extensions: { code: 'CART_EXPIRED' } },
    ])
    expect(response.errors).toEqual(['CART_EXPIRED'])
  })
})

describe('retries', () => {
  it('shows the normalized shape to the retry hook', async () => {
    const before = jest.fn()
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: {
          data: null,
          errors: [{ message: 'Cart expired', extensions: { code: 'CART_EXPIRED', details: { cartId: 'cart-1' } } }],
          extensions: { warnings: extensionWarnings },
        },
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: { booking: { id: 'booking-1' } } } })

    const response = await graphqlRequest({
      failureMode: 'silent',
      axios: { post } as any,
      queryName: 'booking',
      query: 'query booking { booking }',
      variables: {},
      client: client({ max: 1, before }),
    })

    expect(post).toHaveBeenCalledTimes(2)
    expect(before).toHaveBeenCalledTimes(1)
    expect(before.mock.calls[0][0].response).toMatchObject({
      errors: [{ code: 'CART_EXPIRED', cartId: 'cart-1', message: 'Cart expired' }],
      warnings: extensionWarnings,
    })
    expect(response.errors).toBeUndefined()
    expect(response.data).toEqual({ booking: { id: 'booking-1' } })
  })
})

describe('response listeners', () => {
  afterEach(() => jest.restoreAllMocks())

  const createEndpoint = (listener: jest.Mock) =>
    getApiEndpointCreator({
      getClient: () => client({ max: 0, before: () => undefined }),
      responseListeners: [listener],
      typesTree: {},
      maxAge: 0,
      verbose: false,
      formatGraphQL: (query: string) => query,
    })('mutation', 'booking')

  const mockServer = (body: any) => jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, headers: {}, data: body })

  const flushListeners = () => new Promise(resolve => setTimeout(resolve, 0))

  it('sees normalized warnings and errors on raw requests', async () => {
    const listener = jest.fn()
    mockServer({
      data: { booking: null },
      errors: [{ message: 'Coupon rejected', extensions: { code: 'COUPON_INVALID' } }],
      extensions: { warnings: extensionWarnings },
    })

    const response = await createEndpoint(listener).raw({ __alias: 'booking' })
    await flushListeners()

    const expected = {
      warnings: extensionWarnings,
      errors: [{ code: 'COUPON_INVALID', message: 'Coupon rejected', extensions: { code: 'COUPON_INVALID' } }],
    }
    expect(response).toMatchObject(expected)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ response: expect.objectContaining(expected) }))
  })

  it('sees normalized errors when a loud request throws', async () => {
    const listener = jest.fn()
    mockServer({ data: null, errors: [{ message: 'Calendar is blocked', extensions: { code: 'CALENDAR_BLOCKED' } }] })

    const error = await createEndpoint(listener)({ __alias: 'booking' }).catch((e: any) => e)
    await flushListeners()

    expect(error).toBeInstanceOf(GraphQLClientError)
    expect(error.response.errors[0].code).toBe('CALENDAR_BLOCKED')
    expect(listener.mock.calls[0][0].response.errors[0].code).toBe('CALENDAR_BLOCKED')
  })
})
