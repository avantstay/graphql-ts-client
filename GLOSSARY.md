# GraphQL client

Language for selecting GraphQL data, executing operations and deciding whether their results can be used.

## Language

**Operation selection**: A description of one query or mutation root field, its arguments and the fields the caller wants
returned. _Avoid_: Query when the selection describes a mutation

**Operation call**: One invocation of a selected query or mutation. A call may require more than one transport attempt. _Avoid_:
Request when distinguishing a call from one of its attempts

**Operation attempt**: One dispatch of the GraphQL operation for a call. Repeating an attempt does not create a new caller
invocation. _Avoid_: Retry when referring to the first attempt

**Operation outcome**: Whether a call provides complete usable data, usable data with failed fields, or no usable data. This
differs from whether the transport exchange succeeded. _Avoid_: HTTP status as a synonym for data completeness

**Settled source**: A prior classified result declared as provenance for a mutation's inputs. An unsuccessful source prevents the
mutation from being sent. _Avoid_: Cached result or raw response as a synonym for a settled source
