import { MissingSourcesError } from '../types'
import { toSettledFailure } from './classify'
import { AnySettled, isSettled, MutationSources, SettledResponse } from './types'

/** A mutation may only be built from checked reads, so an unrecognised `__settledSources` is a programming error, not a failed outcome. */
export function validateSources(sources: unknown): MutationSources {
  if (sources === 'none') return sources
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every(isSettled)) throw new MissingSourcesError()
  return sources
}

/** The first source that did not fully succeed, whose payload a mutation must not be built from. */
export function findBlockingSource(sources: MutationSources): AnySettled | undefined {
  return Array.isArray(sources) ? sources.find(source => source.outcome !== 'success') : undefined
}

/** The unsent-mutation result for a blocking source, carrying that source's errors, warnings and failed paths. */
export function blockedBySource(blocking: AnySettled): SettledResponse<never> {
  return toSettledFailure({
    outcome: 'failure',
    reason: 'partial-source',
    errors: blocking.errors,
    warnings: blocking.warnings,
    failedPaths: blocking.failedPaths,
    failedSegments: [],
  })
}
