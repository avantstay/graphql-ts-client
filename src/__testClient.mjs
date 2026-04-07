import { getApiEndpointCreator } from "./endpoint";
import { format as formatCode } from "prettier/standalone";
import parserGraphql from "prettier/parser-graphql";
const formatGraphQL = (query) => formatCode(query, { parser: "graphql", plugins: [parserGraphql] });
const BookType = {
  dolor: "DOLOR",
  ipsum: "IPSUM",
  sit: "SIT"
};
const typesTree = {
  Query: {
    get booksWithOptionalParams() {
      return {
        __args: {
          params: "BookSearchParamsAllOptional!"
        }
      };
    },
    get booksWithRequiredParams() {
      return {
        __args: {
          params: "BookSearchParamsSomeRequired!"
        }
      };
    },
    get failingQuery() {
      return {
        __args: {
          id: "String!"
        }
      };
    },
    booksWithoutParams: {}
  }
};
let verbose = false;
let headers = {};
let url = "http://localhost:4123/graphql";
let retryConfig = {
  max: 0,
  before: void 0,
  waitBeforeRetry: 0
};
let responseListeners = [];
let errorsParser = void 0;
let apiEndpoint = getApiEndpointCreator({
  getClient: () => ({ url, headers, retryConfig }),
  responseListeners,
  maxAge: 3e4,
  verbose,
  typesTree,
  formatGraphQL,
  errorsParser
});
const myApiClient = {
  addResponseListener: (listener) => responseListeners.push(listener),
  setHeader: (key, value) => {
    headers[key] = value;
  },
  setHeaders: (newHeaders) => {
    headers = newHeaders;
  },
  setRetryConfig: (options) => {
    if (!Number.isInteger(options.max) || options.max < 0) {
      throw new Error("retryOptions.max should be a non-negative integer");
    }
    retryConfig = {
      max: options.max,
      waitBeforeRetry: options.waitBeforeRetry,
      before: options.before
    };
  },
  setUrl: (_url) => url = _url,
  queries: {
    booksWithoutParams: apiEndpoint("query", "booksWithoutParams"),
    booksWithOptionalParams: apiEndpoint("query", "booksWithOptionalParams"),
    booksWithRequiredParams: apiEndpoint("query", "booksWithRequiredParams"),
    failingQuery: apiEndpoint("query", "failingQuery")
  },
  mutations: {}
};
var stdin_default = myApiClient;
export {
  BookType,
  stdin_default as default,
  myApiClient
};
