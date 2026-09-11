import { RawResponse } from '../types'
import { applyFailedPaths, Classification, toSettled } from './classify'
import { SettledResponse } from './types'

/**
 * A raw endpoint result plus its classification.
 * The property is non-enumerable, so it survives property access but not `{ ...result }` or JSON —
 * which is deliberate: `raw()` hands this object to callers.
 */
export type ClassifiedRawResponse<Data> = RawResponse<Data> & { classification: Classification }

/** Carries the classification alongside a response without it showing up in spreads, JSON, or listener payloads. */
export function attachClassification<T extends object>(target: T, classification: Classification): T {
  Object.defineProperty(target, 'classification', { value: classification, enumerable: false })
  return target
}

/** Turns a raw endpoint result into a settled one, blanking every failed path in the data. */
export function settleRawResult<Data>(rawResult: ClassifiedRawResponse<Data>): SettledResponse<Data> {
  const { classification, status } = rawResult
  if (classification.outcome === 'failure') return toSettled<Data>(null as never, classification, status)
  if (classification.failedSegments.length === 0) return toSettled<Data>(rawResult.data, classification, status)

  // The raw data is shared with the payload response listeners receive on a later tick, so blank a JSON clone of it.
  const normalisedData = JSON.parse(JSON.stringify(rawResult.data))
  applyFailedPaths(normalisedData, classification.failedSegments)
  return toSettled<Data>(normalisedData, classification, status)
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
