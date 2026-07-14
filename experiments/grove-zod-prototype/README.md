# Grove × Zod navigation experiment

**Question:** Does Grove's current graph retrieval beat ordinary lexical search on
real TypeScript navigation tasks, when TypeScript's semantic reference engine is the
ground truth?

This began as a throwaway prototype and is now the retained retrieval regression gate.
It compares Grove and exact-word search on references to real declarations in Zod v4 core. Results
include precision, recall, latency, and JSON payload bytes.

```bash
bun experiments/grove-zod-prototype/benchmark.ts
```

Set `ZOD_DIR=/path/to/zod` to use an existing checkout. Otherwise the command shallow-
clones the official Zod repository into `/tmp/grove-zod-navigation-prototype`.

The measured baseline and decision live in `NOTES.md`.
