# Grove design

## Thesis

Agents should navigate large codebases by querying precise semantic and runtime evidence,
not by loading files until the answer happens to enter context.

## Authority

```text
source files ──TypeScript compiler──> symbols + references ──> SQLite
     │                                                     └─> trace joins
     └──staged source edits──validate/hash/rollback──> source files
```

Files and the language compiler are authoritative. SQLite is a disposable query index.
Deleting it loses no program state.

## Identity

A semantic symbol is a compiler symbol, not a name. Its stable external ID hashes the
compiler-qualified name and declaration kind after replacing the absolute workspace root.
Distinct modules may therefore define the same name without collision. Import aliases
resolve to the target compiler symbol.

## Retrieval

Queries select a symbol by ID, then return compact locations. Full declaration source is
read directly from disk only when requested. Trace spans link to the same symbol ID.

## Mutation

Edits replace complete declarations and remain in memory until commit. Preview checks the
indexed content hash, rejects overlapping edits, and performs syntax validation. Commit
writes all temporary files first, backs up every original, installs replacements, and
rolls every file back if installation fails. Successful commit is followed by re-indexing.

This is transactional rollback, not a claim that multiple filesystem renames are globally
atomic to concurrent readers.

## Current scope

TypeScript only. Top-level declarations, variables, class/interface members, accessors,
types, enums, and enum members are indexed. The index is rebuilt as one transaction.

## Gates

Before expanding into browser or live-runtime features:

1. >=95% precision and recall against compiler ground truth.
2. Index 10k LOC in under 30 seconds on the reference machine.
3. Return less context than lexical search on representative navigation tasks.
4. Small model + Grove matches a larger model using raw files at lower total cost.

The first three are automated by the Zod experiment. The fourth requires an external
model-evaluation harness and is the next product experiment after retrieval passes.
