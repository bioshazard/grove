# Grove

Queryable compiler semantics and runtime evidence for coding agents.

Grove keeps source files authoritative. It asks TypeScript for symbol identity and
references, persists that compact semantic index beside runtime traces, and returns only
the source slices an agent requests. Same-name symbols remain distinct. Aliases resolve
to their actual declaration.

## Use

```bash
bun install
bun run index
bun index.ts symbols createUser
bun index.ts references <symbol-id>
```

Start the MCP server with `bun run mcp`. Its tools cover indexing, symbol retrieval,
references, trace queries, and staged declaration replacement.

## Guarantees

- Source lives only in files, never in SQLite.
- Symbol IDs derive from compiler identity, not names.
- References are compiler-resolved semantic edges.
- Edits fail if files changed since indexing.
- Multi-file edits validate first and roll back on commit failure.
- Trace SQL is read-only through the public API.

## Verify

```bash
bun test
bun run typecheck
bun run benchmark:zod
```

The Zod benchmark compares Grove and exact-word search against TypeScript semantic
references. See [the experiment](experiments/grove-zod-prototype/README.md).
