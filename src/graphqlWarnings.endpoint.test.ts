import axios from 'axios'
import { getApiEndpointCreator } from './endpoint'

describe('Endpoint warning compatibility', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each(['legacy', 'extensions', 'both'])('keeps %s warnings on raw results and response listeners', async shape => {
    const warnings = [{ message: 'Cannot modify booking' }]
    const errors = [{ message: 'Booking alteration failed', extensions: { code: 'SERVICE_DEFINED' } }]
    const listener = jest.fn()
    jest.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        data: { alterBooking: { changed: null } },
        errors,
        ...(shape !== 'extensions' ? { warnings } : {}),
        ...(shape !== 'legacy' ? { extensions: { warnings } } : {}),
      },
    })
    const endpoint = getApiEndpointCreator({
      getClient: () => ({ url: 'https://example.invalid/graphql', headers: {}, retryConfig: { max: 0, before: () => undefined } }),
      requestListeners: [],
      responseListeners: [listener],
      typesTree: {},
      maxAge: 0,
      verbose: false,
      formatGraphQL: (query: string) => query,
    })('mutation', 'booking')

    const response = await endpoint.raw({ __alias: 'alterBooking' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(response).toMatchObject({ data: { changed: null }, errors, warnings })
    expect(response.warnings).toHaveLength(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ response: expect.objectContaining({ warnings, errors }) }))
    expect(axios.post).toHaveBeenCalledTimes(1)
  })
})
