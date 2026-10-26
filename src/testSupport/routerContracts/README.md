# Router contract fixtures

Targets: Apollo Router 2.16.3 and Hive Router 0.3.5 with AvantStay's `apollo_compat` plugin after
[router !74](https://gitlab.com/avantstay/backend/apollo-router/-/merge_requests/74), commit
`40f2cd15443cf5126a72051e09063ab75497b629`. Sources are `tests/e2e/e2e.test.mjs`, `tests/e2e/fixtures.mjs` and
`avant-hive-router/src/plugins/apollo_compat.rs` in that repository. !74 reports Docker E2E runs against both routers. These are
local replay fixtures, not staging captures or a live router verification by this client suite.

Every response has a `provenance` field. Full envelopes reconstructed from E2E assertions, and illustrative diagnostics, are
labelled synthesized. The success body comes from the E2E assertion. The validation body comes from Apollo's
[2.16.3 validation snapshot](https://github.com/apollographql/router/blob/v2.16.3/apollo-router/src/services/router/tests.rs);
Hive's equivalent is synthesized. Hive's parser and missing-variable diagnostics come from its
[0.3.5 parser](https://github.com/graphql-hive/router/blob/04a8c26a763119465c6222730a94c662eae2e37a/e2e/src/error_handling.rs) and
[coercion snapshots](https://github.com/graphql-hive/router/blob/04a8c26a763119465c6222730a94c662eae2e37a/e2e/src/variables_coercion.rs),
with status and codes updated to the post-!74 contract. Apollo's coercion `name` extension is preserved; Hive does not add it.
Null/wrong-type variable and CSRF messages are synthesized, not assertions of exact router wording.

Request fixtures cover validation, operation selection, parsing, missing/null/wrong-type variables, CSRF and GET mutation
rejection. They use HTTP 400, except GET mutation at 405 with `Allow: POST`. Coercion now has the same
`VALIDATION_INVALID_TYPE_VARIABLE` code on both routers. Subgraph `BAD_USER_INPUT` stays HTTP 200 with partial data and its error
path. The additional synthesized `UNAUTHENTICATED` variant is retained; the local auth plugins emit `UNAUTHORIZED`.

Tests replay each body through `classify`, `graphqlRequest` and endpoint `settle()`, preserving each fixture's diagnostics,
locations, extensions and raw headers. Cross-router comparisons cover status, outcome, reason, data, warnings, failed paths, error
paths, codes and redaction. Diagnostic wording, locations and coercion `extensions.name` can differ by router. Configured HTTP
query retries and the optional one-time 401 retry retain 13.2.0 behavior; partial responses are not retried.

Runtime code and `package.json` remain identical to 13.2.0. This fixture-only change needs no package release; version bumps are
part of the separate release process documented in the root README.
