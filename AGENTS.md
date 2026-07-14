@/Users/bios/.codex/RTK.md

Be extremely concise. Sacrifice grammar for concision.

## Immutable

- The mutable portion is the agent memory layer. Update it when architecture changes.

## Mutable

### Architecture

- Files and TypeScript compiler are authoritative. SQLite is disposable query index.
- `src/semantic-index.ts` derives stable symbol IDs and semantic references.
- Type/value facets must stay distinct for merged declarations such as interface + const.
- SQLite stores file hashes, symbols, references, and traces. Never source text/CST nodes.
- `WorkspaceSession` stages whole-declaration replacements, rejects stale hashes/overlap,
  syntax-checks, then installs with rollback. Re-index after commit.
- MCP surface intentionally small: index, symbol query/references, staged edits, traces.
- Grove is a program-evidence mechanism, not a Goal System: callers own intent,
  authority, evaluation, steering, terminality, and receipts.
- The program/evidence graph is a logical, disposable projection. Do not introduce a
  graph-database commitment or store product ontology as Grove authority.

### Gates

- `bun test`
- `bun run typecheck`
- `bun run benchmark:zod`
- Zod baseline: 12,072 LOC; 99.8% precision, 99.5% recall, 5.5s index, 4.2ms query.
- Next implementation experiment: external bounded-modernization Goal System using
  Grove, project typecheck/tests, and a typed receipt.
- Subsequent product experiment: small model + Grove vs larger model + raw files.

### Lessons

- Name identity fails on duplicate symbols and aliases.
- Compiler symbols can merge type/value declarations; index facets separately.
- Persisting every CST node was slow and broke lossless roundtrip. Do not revive it.
- Filesystem multi-file install offers rollback, not global atomic visibility; say so.
