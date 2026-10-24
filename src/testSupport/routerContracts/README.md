# Router contract fixtures

Targets: Apollo Router 2.16.3 and Hive Router 0.3.5 with AvantStay's `apollo_compat` plugin. Each response has a `provenance`
field. These are local contract fixtures, not staging captures or evidence of a live router run.

The success body is copied from the local router E2E assertion. Partial responses, masking, domain codes and `UNAUTHORIZED` auth
failures reconstruct the complete envelope from those tests and fixture builders. They are labelled synthesized because the tests
assert individual fields rather than store complete responses. The requested `UNAUTHENTICATED` case is an additional synthesized
variant; the auth plugins actually emit `UNAUTHORIZED`.

Sources in the sibling `apollo-router` checkout, inspected at `2e979cddc58d3dcb96cc58de272b6e088f940a13`:
`tests/e2e/e2e.test.mjs`, `tests/e2e/fixtures.mjs`, `avant-router/src/plugins/backoffice_authentication.rs`,
`avant-hive-router/src/plugins/backoffice_authentication.rs`, and `avant-hive-router/src/plugins/apollo_compat.rs`. The rollout
context is in `docs/research/hive-error-contract-rollout.md` and `docs/research/hive-apollo-compatibility.md` in that checkout.

Apollo's validation body is copied from the
[2.16.3 validation snapshot](https://github.com/apollographql/router/blob/v2.16.3/apollo-router/src/services/router/tests.rs).
Hive's equivalent diagnostic is synthesized; the compat plugin preserves diagnostics and remaps validation to HTTP 400 with
`GRAPHQL_VALIDATION_FAILED`. Apollo's parser diagnostic is synthesized. Hive's parse body is copied from
[0.3.5 error_handling.rs](https://github.com/graphql-hive/router/blob/04a8c26a763119465c6222730a94c662eae2e37a/e2e/src/error_handling.rs).
Its legacy HTTP 200 is derived from
[ClientPipelineError::default_status_code](https://github.com/graphql-hive/router/blob/04a8c26a763119465c6222730a94c662eae2e37a/bin/router/src/pipeline/error.rs).
The tests preserve every router's full diagnostics and compare codes, extensions, paths and redaction across routers. Parser
wording and locations may differ.

Hive's coercion body and legacy HTTP 200 come from
[0.3.5 variables_coercion.rs](https://github.com/graphql-hive/router/blob/04a8c26a763119465c6222730a94c662eae2e37a/e2e/src/variables_coercion.rs).
Apollo's diagnostic is synthesized, with its code and `name` extension verified against
[FetchError](https://github.com/apollographql/router/blob/v2.16.3/apollo-router/src/error.rs), and HTTP 400 verified in
[supergraph service](https://github.com/apollographql/router/blob/v2.16.3/apollo-router/src/services/supergraph/service.rs).
Apollo uses `VALIDATION_INVALID_TYPE_VARIABLE`; Hive uses `BAD_USER_INPUT`. The current compat plugin does not remap coercion. The
tests explicitly retain this mismatch in errors and error retries. Equal failure reasons do not establish full coercion parity.
Fixing the router contract remains a separate rollout gate.
