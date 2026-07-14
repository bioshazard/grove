# Zod benchmark verdict

Official Zod commit `912f0f51b0ced654d0069741e7160834dca742ee`; 19 production
files / 12,072 LOC from `packages/zod/src/v4/core`; TypeScript semantic references
provide ground truth.

## Compiler-backed index: provisional go

- Index: 5.47s, 1,164 symbols, 4,917 reference edges.
- Grove: 99.81% precision, 99.52% recall, 4.21ms mean query, 1,160 mean bytes.
- Exact-word `rg`: 81.31% precision, 99.96% recall, 36.86ms mean query, 1,687 mean bytes.
- Grove is 8.8x faster per query and returns 31% less location context.

The remaining recall difference is a few import/type-value facet locations. It clears the
>=95% gate comfortably. The old CST/name index scored 71.7% precision, 82.5% recall,
took 37.8s to hydrate, and failed roundtrip on 14/19 files.

## Decision

Retain this as the retrieval regression benchmark. The compiler-backed semantic index is
viable. Next experiment: small model + Grove against larger model + raw files on fixed
navigation/change tasks, measuring correctness, input tokens, latency, and total cost.
