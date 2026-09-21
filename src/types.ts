import type { FailureReason, MutationSources, Outcome, SettledResponse } from './settle/types'

export type Maybe<Value> = null | undefined | Value
export type Defined<Value> = Exclude<Value, undefined>

/** Whether an operation reads or writes: the two GraphQL root operations this client emits. */
export type OperationKind = 'query' | 'mutation'

/** How a failed request reports itself: `loud` throws `GraphQLClientError`, `silent` resolves with the errors. */
export type FailureMode = 'loud' | 'silent'

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
type ProjectArray<Selection, Base extends readonly unknown[], Ignored> = ArrayElement<Base> extends Primitive | Ignored
  ? ArrayElement<Base>[]
  : Projection<Defined<Selection>, ArrayElement<Base>, Ignored>[]

/** The leaf arm of `Projection`: an unselected leaf may be absent, a selected one is exactly its base type. */
type ProjectLeaf<Selection, Base> = Selection extends undefined ? Base | undefined : Base

/** One property of `ProjectObject`: a boolean-selected key keeps the base type as it is, an array is projected element by element, anything else is projected one level deeper. */
type ProjectField<Selection, Base, Key extends keyof Selection & keyof Base, Ignored> = Selection[Key] extends boolean
  ? Base[Key]
  : Base[Key] extends Array<infer Element>
  ? Projection<Defined<Selection[Key]>, Element, Ignored>[]
  : Projection<Defined<Selection[Key]>, Base[Key], Ignored>

/** The object arm of `Projection`: every key the selection and the base share, projected one level deeper. */
type ProjectObject<Selection, Base, Ignored> = {
  [Key in keyof Selection & keyof Base]: ProjectField<Selection, Base, Key, Ignored>
}

// Projection is the resulting type of Selection (type generated out of a query) applied to Base (generated graphql type)
export type Projection<Selection, Base, Ignored = never> = Base extends Array<any>
  ? ProjectArray<Selection, Base, Ignored>
  : Base extends Primitive | Ignored
  ? ProjectLeaf<Selection, Base>
  : ProjectObject<Selection, Base, Ignored>

export type Unpacked<Value> = Value extends (infer Element)[]
  ? Element
  : Value extends (...args: any[]) => infer Returned
  ? Returned
  : Value extends Promise<infer Resolved>
  ? Resolved
  : Value

export type Replacement<Mapping extends [any, any], Value> = Mapping extends any
  ? [Value] extends [Mapping[0]]
    ? Mapping[1]
    : never
  : never

/** One value of `DeepReplace`: recurse into an object, leave every other value as it is. `T[P]` stays an indexed access, which never distributes. */
type DeepReplaceValue<Source, Key extends keyof Source, Ignored, Mapping extends [any, any]> = Source[Key] extends object
  ? DeepReplace<Source[Key], Ignored, Mapping>
  : Source[Key]

/** One matched leaf of `DeepReplace`: an ignored type is only recursed into, anything else is swapped for its replacement. */
type ReplaceLeaf<Source, Key extends keyof Source, Ignored, Mapping extends [any, any]> = Source[Key] extends Ignored
  ? DeepReplaceValue<Source, Key, Ignored, Mapping>
  : Replacement<Mapping, Source[Key]>

export type DeepReplace<Source, Ignored, Mapping extends [any, any]> = {
  [Key in keyof Source]: Source[Key] extends Mapping[0]
    ? ReplaceLeaf<Source, Key, Ignored, Mapping>
    : DeepReplaceValue<Source, Key, Ignored, Mapping>
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
export type RawEndpoint<Selectable, Result, Ignored> = <Selection extends Selectable>(
  jsonQuery?: Selection & TolerateSettledSources
) => Promise<RawResponse<Projection<Selection, Result, Ignored>>>

/** The `settle()` call signature for a query. */
export type SettleEndpoint<Selectable, Result, Ignored> = <Selection extends Selectable>(
  jsonQuery?: Selection
) => Promise<SettledResponse<Projection<Selection, Result, Ignored>>>

/** The `settle()` call signature for a mutation, which requires `__settledSources`. */
export type MutationSettleEndpoint<Selectable, Result, Ignored> = <Selection extends Selectable>(
  jsonQuery: Selection & {
    /** The settled results this mutation payload was built from, or `'none'` when it was built from no query. */
    __settledSources: MutationSources
  }
) => Promise<SettledResponse<Projection<Selection, Result, Ignored>>>

export type JsonOutput<Result, Ignored> = DeepReplace<Result, Ignored, [string | Date, string]>

/** Everything an endpoint offers apart from `settle()`, which differs between queries and mutations. */
type EndpointBase<Selectable, Result, Ignored> = (<Selection extends Selectable>(
  jsonQuery?: Selection
) => Promise<Projection<Selection, JsonOutput<Result, Ignored>, Ignored>>) & {
  memo: <Selection extends Selectable>(
    jsonQuery?: Selection
  ) => Promise<Projection<Selection, JsonOutput<Result, Ignored>, Ignored>>
  memoRaw: RawEndpoint<Selectable, JsonOutput<Result, Ignored>, Ignored>
  raw: RawEndpoint<Selectable, JsonOutput<Result, Ignored>, Ignored>
}

export type Endpoint<Selectable, Result, Ignored> = EndpointBase<Selectable, Result, Ignored> & {
  settle: SettleEndpoint<Selectable, JsonOutput<Result, Ignored>, Ignored>
}

/** An Endpoint whose `settle()` requires `__settledSources`. */
export type MutationEndpoint<Selectable, Result, Ignored> = EndpointBase<Selectable, Result, Ignored> & {
  settle: MutationSettleEndpoint<Selectable, JsonOutput<Result, Ignored>, Ignored>
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
