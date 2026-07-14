# Keep Grove a program-evidence mechanism

Grove will expose a compiler-grounded, queryable projection of program structure, bounded declaration mutation, and static/runtime observations. It will not own product intent, transition authority, evaluation, steering, terminality, or receipts; a surrounding Goal System must govern those responsibilities. This keeps files and compilers authoritative, keeps the graph disposable, and prevents product ontology and workflow machinery from entering Grove's small interface.

## Consequences

- The graph is a logical model, not a graph-database commitment. SQLite remains a disposable query index.
- Product capabilities and policies may link to stable Grove symbol IDs, but product intent remains authoritative outside Grove.
- Grove reports observations and enforces its mutation envelope. Callers decide whether evidence satisfies an obligation.
- Receipts reference Grove symbol IDs, file hashes, traces, and artifacts; Grove does not own receipt lifecycle.
- New graph edges must be compiler-derived, runtime-observed, or explicitly provenance-labeled. Inference must not masquerade as authority.

## Next experiment

Build one external, bounded-modernization Goal System around Grove. It should authorize an exact declaration set, stage an API migration, independently run project typechecking and tests, accept or reject from that evidence, and emit a receipt. Include successful, unauthorized-change, and semantic-regression paths. Do not add a Product DSL or general graph schema until this slice demonstrates a missing relation or obligation.
