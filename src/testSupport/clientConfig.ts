import { ClientConfig } from '../types'

/** The one client config every `graphqlRequest` test starts from; tests vary only the retry count and its extras. */
export function clientWithRetries(
  max: number,
  extra: { waitBeforeRetry?: number; before?: (info: any) => void } = {}
): ClientConfig {
  return {
    url: 'https://example.invalid/graphql',
    headers: {},
    retryConfig: { max, before: () => undefined, ...extra },
  }
}
