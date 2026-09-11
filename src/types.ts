import type { FailureReason, MutationSources, Outcome, SettledResponse } from './settle/types'

export type Maybe<T> = null | undefined | T
export type Defined<T> = Exclude<T, undefined>

export type ResponseData = {
  data: any
  warnings: any
  headers: any
  status?: number
  errors: {
    message: string
  }[]
  outcome?: Outcome
  reason?: FailureReason
  failedPaths?: string[]
  /** Internal: the full classification `endpoint.settle()` reads, typed `unknown` so its shape stays private. */
  classification?: unknown
}

export type RequestListenerInfo = {
  queryName: string
  query: string
  variables: any
  headers: { [key: string]: string }
}
export type IRequestListener = (info: RequestListenerInfo) => void | Promise<void>

export type ResponseListenerInfo = {
  queryName: string
  query: string
  variables: any
  response: ResponseData
}
export type IResponseListener = (info: ResponseListenerInfo) => void | Promise<void>

type ArrayElement<ArrayType extends readonly unknown[]> = ArrayType extends readonly (infer ElementType)[] ? ElementType : never

type Primitive = Date | string | number | boolean | null | undefined

/** The array arm of `Projection`: a list of leaves stays as it is, a list of objects is projected element by element. */
type ProjectArray<Selection, Base extends readonly unknown[], E> = ArrayElement<Base> extends Primitive | E
  ? ArrayElement<Base>[]
  : Projection<Defined<Selection>, ArrayElement<Base>, E>[]

/** The leaf arm of `Projection`: an unselected leaf may be absent, a selected one is exactly its base type. */
type ProjectLeaf<Selection, Base> = Selection extends undefined ? Base | undefined : Base

/** One property of `ProjectObject`: a boolean-selected key keeps the base type as it is, an array is projected element by element, anything else is projected one level deeper. */
type ProjectField<Selection, Base, k extends keyof Selection & keyof Base, E> = Selection[k] extends boolean
  ? Base[k]
  : Base[k] extends Array<infer A>
  ? Projection<Defined<Selection[k]>, A, E>[]
  : Projection<Defined<Selection[k]>, Base[k], E>

/** The object arm of `Projection`: every key the selection and the base share, projected one level deeper. */
type ProjectObject<Selection, Base, E> = {
  [k in keyof Selection & keyof Base]: ProjectField<Selection, Base, k, E>
}

// Projection is the resulting type of Selection (type generated out of a query) applied to Base (generated graphql type)
export type Projection<Selection, Base, E = never> = Base extends Array<any>
  ? ProjectArray<Selection, Base, E>
  : Base extends Primitive | E
  ? ProjectLeaf<Selection, Base>
  : ProjectObject<Selection, Base, E>

export type Unpacked<T> = T extends (infer U)[]
  ? U
  : T extends (...args: any[]) => infer U
  ? U
  : T extends Promise<infer U>
  ? U
  : T

export type Replacement<M extends [any, any], T> = M extends any ? ([T] extends [M[0]] ? M[1] : never) : never

/** One value of `DeepReplace`: recurse into an object, leave every other value as it is. `T[P]` stays an indexed access, which never distributes. */
type DeepReplaceValue<T, P extends keyof T, Ignore, M extends [any, any]> = T[P] extends object
  ? DeepReplace<T[P], Ignore, M>
  : T[P]

/** One matched leaf of `DeepReplace`: an ignored type is only recursed into, anything else is swapped for its replacement. */
type ReplaceLeaf<T, P extends keyof T, Ignore, M extends [any, any]> = T[P] extends Ignore
  ? DeepReplaceValue<T, P, Ignore, M>
  : Replacement<M, T[P]>

export type DeepReplace<T, Ignore, M extends [any, any]> = {
  [P in keyof T]: T[P] extends M[0] ? ReplaceLeaf<T, P, Ignore, M> : DeepReplaceValue<T, P, Ignore, M>
}

/** What `raw()` returns: the server payload untouched, plus the outcome fields. */
export type RawResponse<Data> = {
  data: Data
  errors: any[]
  warnings?: any[]
  headers: any
  status: number
  outcome: Outcome
  reason?: FailureReason
  failedPaths: string[]
}

/** Lets `raw()` tolerate a `__settledSources` copied from a mutation call; `raw()` ignores it. */
export type TolerateSettledSources = {
  __settledSources?: MutationSources
}

/** The `raw()` call signature: never throws on GraphQL errors, and reports them through the outcome fields. */
export type RawEndpoint<I, O, E> = <S extends I>(
  jsonQuery?: S & TolerateSettledSources
) => Promise<RawResponse<Projection<S, O, E>>>

/** The `settle()` call signature for a query. */
export type SettleEndpoint<I, O, E> = <S extends I>(jsonQuery?: S) => Promise<SettledResponse<Projection<S, O, E>>>

/** The `settle()` call signature for a mutation, which requires `__settledSources`. */
export type MutationSettleEndpoint<I, O, E> = <S extends I>(
  jsonQuery: S & {
    /** The settled results this mutation payload was built from, or `'none'` when it was built from no query. */
    __settledSources: MutationSources
  }
) => Promise<SettledResponse<Projection<S, O, E>>>

export type JsonOutput<O, ToBeIgnored> = DeepReplace<O, ToBeIgnored, [string | Date, string]>

/** Everything an endpoint offers apart from `settle()`, which differs between queries and mutations. */
type EndpointBase<I, O, E> = (<S extends I>(jsonQuery?: S) => Promise<Projection<S, JsonOutput<O, E>, E>>) & {
  memo: <S extends I>(jsonQuery?: S) => Promise<Projection<S, JsonOutput<O, E>, E>>
  memoRaw: RawEndpoint<I, JsonOutput<O, E>, E>
  raw: RawEndpoint<I, JsonOutput<O, E>, E>
}

export type Endpoint<I, O, E> = EndpointBase<I, O, E> & { settle: SettleEndpoint<I, JsonOutput<O, E>, E> }

/** An Endpoint whose `settle()` requires `__settledSources`. */
export type MutationEndpoint<I, O, E> = EndpointBase<I, O, E> & {
  settle: MutationSettleEndpoint<I, JsonOutput<O, E>, E>
}

const MISSING_SOURCES_BRAND = Symbol.for('@avantstay/graphql-ts-client/MissingSourcesError')
const GRAPHQL_CLIENT_ERROR_BRAND = Symbol.for('@avantstay/graphql-ts-client/GraphQLClientError')

/** True when `value` carries `brand` or descends from `classPrototype`, so `instanceof` holds across tsup's two bundles. */
function isBrandedInstance(value: unknown, brand: symbol, classPrototype: object): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  // The prototype arm stays because the es5 `_classCallCheck` runs `this instanceof Ctor` before the constructor sets the brand.
  return (value as Record<symbol, unknown>)[brand] === true || Object.prototype.isPrototypeOf.call(classPrototype, value)
}

/** Sets `error.name` non-enumerably, like `Error.prototype.name`, so it stays out of `{ ...error }` and JSON.stringify. */
function nameError(error: Error, name: string): void {
  Object.defineProperty(error, 'name', { value: name, enumerable: false, configurable: true, writable: true })
}

/** Thrown by `settle()` on a mutation whose `__settledSources` is missing, empty, or not a list of settled results. */
export class MissingSourcesError extends Error {
  constructor() {
    super(
      "settle() on a mutation requires __settledSources: the settled results the payload was built from, or 'none'; an empty array or a non-settled value is not a list of sources"
    )
    nameError(this, 'MissingSourcesError')
    Object.setPrototypeOf(this, MissingSourcesError.prototype)
    Object.defineProperty(this, MISSING_SOURCES_BRAND, { value: true, enumerable: false })
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedInstance(value, MISSING_SOURCES_BRAND, this.prototype)
  }
}

export type ClientConfig = {
  url: string
  headers: {
    [key: string]: string
  }
  retryConfig: {
    max: number
    waitBeforeRetry?: number
    before: IResponseListener
  }
}

export type LogInfo = {
  query: string
  variables: any
  formatGraphQL: any
  kind: string
  queryName: string
  response?: any
  error?: Error
  duration: number
}

export type TypescriptClientOutput = {
  js: string
  mjs: string
  typings: string
}

export class GraphQLClientError extends Error {
  responseData: ResponseData

  constructor(responseData: ResponseData) {
    super()
    this.responseData = responseData
    nameError(this, 'GraphQLClientError')
    Object.setPrototypeOf(this, GraphQLClientError.prototype)
    Object.defineProperty(this, GRAPHQL_CLIENT_ERROR_BRAND, { value: true, enumerable: false })
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedInstance(value, GRAPHQL_CLIENT_ERROR_BRAND, this.prototype)
  }

  get message(): string {
    return this.response.errors.map(it => it.message).join(';\n')
  }

  get response(): ResponseData {
    return this.responseData
  }
}
