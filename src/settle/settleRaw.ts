import { RawResponse } from '../types'
import { applyFailedPaths, Classification, toSettled } from './classify'
import { SettledResponse } from './types'

/** A raw endpoint result plus the non-enumerable `classification` the endpoint re-attaches to it. */
export type ClassifiedRawResponse<Data> = RawResponse<Data> & { classification: Classification }

/** Turns a raw endpoint result into a settled one, blanking every failed path in the data. */
export function settleRawResult<Data>(rawResult: ClassifiedRawResponse<Data>): SettledResponse<Data> {
  const { classification } = rawResult
  let normalisedData = rawResult.data
  if (classification.outcome !== 'failure' && classification.failedSegments.length > 0) {
    // The raw data is shared with the payload response listeners receive on a later tick, so normalise a JSON clone of it.
    normalisedData = JSON.parse(JSON.stringify(rawResult.data))
    applyFailedPaths(normalisedData, classification.failedSegments)
  }
  const data = classification.outcome === 'failure' ? (null as never) : normalisedData
  return toSettled<Data>(data, classification, rawResult.status)
}

/** Turns an error thrown by the transport or the client into an `outcome: 'failure'`, `reason: 'http'` result. */
export function settleThrown(error: unknown): SettledResponse<never> {
  return toSettled<never>(null as never, {
    outcome: 'failure',
    reason: 'http',
    errors: [{ message: error instanceof Error ? error.message : String(error), redacted: false }],
    warnings: [],
    failedPaths: [],
    failedSegments: [],
  })
}
