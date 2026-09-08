import type { Classification } from './settle/classify'
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
  // Optional so consumers that construct a ResponseData by hand (mocked listener payloads, test doubles,
  // hand-rolled `new GraphQLClientError({...})`) keep compiling against v12-shaped objects. Every response
  // the client itself produces populates them; RawResponse, the raw() contract, keeps them required.
  outcome?: Outcome
  reason?: FailureReason
  failedPaths?: string[]
  codes?: string[]
  requestIds?: string[]
  /** Internal: full classification, consumed by endpoint.settle(). Not part of the raw() contract. */
  classification?: Classification
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

// Projection is the resulting type of Selection (type generated out of a query) applied to Base (generated graphql type)
export type Projection<Selection, Base, E = never> = Base extends Array<any>
  ? ArrayElement<Base> extends Primitive | E
    ? ArrayElement<Base>[]
    : Projection<Defined<Selection>, ArrayElement<Base>, E>[]
  : Base extends Primitive | E
  ? // Is primitive and extends undefined
    Selection extends undefined
    ? Base | undefined
    : Base
  : {
      [k in keyof Selection & keyof Base]: Selection[k] extends boolean
        ? Base[k]
        : Base[k] extends Array<infer A>
        ? Projection<Defined<Selection[k]>, A, E>[]
        : Projection<Defined<Selection[k]>, Base[k], E>
    }

export type Unpacked<T> = T extends (infer U)[]
  ? U
  : T extends (...args: any[]) => infer U
  ? U
  : T extends Promise<infer U>
  ? U
  : T

export type Replacement<M extends [any, any], T> = M extends any ? ([T] extends [M[0]] ? M[1] : never) : never

export type DeepReplace<T, Ignore, M extends [any, any]> = {
  [P in keyof T]: T[P] extends M[0]
    ? T[P] extends Ignore
      ? T[P] extends object
        ? DeepReplace<T[P], Ignore, M>
        : T[P]
      : Replacement<M, T[P]>
    : T[P] extends object
    ? DeepReplace<T[P], Ignore, M>
    : T[P]
}

export type RawResponse<Data> = {
  data: Data
  errors: any[]
  warnings: any[]
  headers: any
  status: any
  outcome: Outcome
  reason?: FailureReason
  failedPaths: string[]
  codes: string[]
  requestIds: string[]
}

export type CallOptions = { __require?: string[]; __sources?: MutationSources }

export type RawEndpoint<I, O, E> = <S extends I>(jsonQuery?: S & CallOptions) => Promise<RawResponse<Projection<S, O, E>>>

export type SettleEndpoint<I, O, E> = <S extends I>(
  jsonQuery?: S & { __require?: string[] }
) => Promise<SettledResponse<Projection<S, O, E>>>

export type MutationSettleEndpoint<I, O, E> = <S extends I>(
  jsonQuery: S & { __require?: string[]; __sources: MutationSources }
) => Promise<SettledResponse<Projection<S, O, E>>>

export type JsonOutput<O, ToBeIgnored> = DeepReplace<O, ToBeIgnored, [string | Date, string]>

export type Endpoint<I, O, E> = (<S extends I>(jsonQuery?: S) => Promise<Projection<S, JsonOutput<O, E>, E>>) & {
  memo: <S extends I>(jsonQuery?: S) => Promise<Projection<S, JsonOutput<O, E>, E>>
  memoRaw: RawEndpoint<I, JsonOutput<O, E>, E>
  raw: RawEndpoint<I, JsonOutput<O, E>, E>
  settle: SettleEndpoint<I, JsonOutput<O, E>, E>
}

// Not `Omit<Endpoint<...>, 'settle'> & {...}`: Omit is a mapped type and mapped types drop a type's call
// signature, which would make a MutationEndpoint not callable as a function. Defined explicitly instead,
// mirroring Endpoint's shape with `settle` replaced by MutationSettleEndpoint.
export type MutationEndpoint<I, O, E> = (<S extends I>(jsonQuery?: S) => Promise<Projection<S, JsonOutput<O, E>, E>>) & {
  memo: <S extends I>(jsonQuery?: S) => Promise<Projection<S, JsonOutput<O, E>, E>>
  memoRaw: RawEndpoint<I, JsonOutput<O, E>, E>
  raw: RawEndpoint<I, JsonOutput<O, E>, E>
  settle: MutationSettleEndpoint<I, JsonOutput<O, E>, E>
}

// `tsup src/index.ts src/endpoint.ts` emits two independent bundles, each embedding its own copy of these
// classes: an error thrown from the endpoint bundle fails a plain prototype-chain `instanceof` against the
// class imported from the index bundle. A `Symbol.for` brand plus `Symbol.hasInstance` makes the check
// identity-based instead of prototype-based, so it holds across bundles — the same trick as SETTLED_BRAND.
const MISSING_SOURCES_BRAND = Symbol.for('@avantstay/graphql-ts-client/MissingSourcesError')
const GRAPHQL_CLIENT_ERROR_BRAND = Symbol.for('@avantstay/graphql-ts-client/GraphQLClientError')

// The prototype-chain arm is not redundant: the build targets es5, so classes are downlevelled and every
// constructor opens with `_classCallCheck(this, Ctor)`, i.e. `this instanceof Ctor` — evaluated before the
// constructor body has had a chance to set the brand. A brand-only predicate makes that check fail and
// `new GraphQLClientError(...)` throws "Cannot call a class as a function" in the built bundles.
function isBrandedInstance(value: unknown, brand: symbol, classPrototype: object): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return (value as any)[brand] === true || Object.prototype.isPrototypeOf.call(classPrototype, value)
}

export class MissingSourcesError extends Error {
  constructor() {
    super(
      'settle() on a mutation requires __sources: the settled results the payload was built from, or { none: reason }; an empty array is not a source list'
    )
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
