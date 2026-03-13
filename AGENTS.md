## Immutable

- The mutable portion of this is yours to manage as your memory layer to save yourself from re-discovering stuff next time

## Mutable

### Lessons Learned (Phase 4 - REPL Integration)

**Bug: Function evaluation returning undefined**
- Issue: `new Function(code + '\n(funcName)')()` returned undefined for function declarations
- Root cause: Function declarations in `new Function` scope don't return the function when accessed directly
- Fix: Use exports pattern: `new Function('exports', code + '\nObject.defineProperty(exports, "name", {value: name})')(exports)`

**Bug: TypeScript type annotation stripping**
- Issue: Parameter types like `name: string` weren't being removed correctly
- Root cause: Regex was too greedy, matching `function greet(name: string` instead of just `name: string`
- Fix: Use lookbehind/lookahead: `/(?<=[a-zA-Z_]\w*)\s*:\s*(type)(?=\s*[),])/g`

**Bug: File ID mismatch on re-hydration**
- Issue: After writeback, nodes had wrong file_id causing JOIN queries to fail
- Root cause: `addFile` used `ON CONFLICT DO UPDATE` but read `lastInsertRowid` which gave next auto-increment value
- Fix: Check for existing file first, update if exists, return correct ID

**Bug: Clear order for cascade deletes**
- Issue: Symbols not being deleted on re-hydration
- Root cause: Deleting nodes before symbols meant subquery returned empty
- Fix: Delete symbols first (they reference nodes), then nodes

### Architecture Notes

The REPL is now a true peer to the graph:
1. `loadSymbolsIntoRepl` - extracts function/class declarations from graph, strips TS annotations, loads into runtime context
2. `replCallSymbol` - calls functions by name with args, optional trace capture
3. `replUpdateSymbol` - live redefinition without re-hydration
4. `replWriteback` - commits modified function back to graph (updates source, increments version)

Red/green loop against real traced inputs now works:
- Query traces for error patterns
- Extract problematic inputs from trace attributes  
- Call symbol with those inputs → RED
- Fix in REPL → GREEN
- Writeback to graph
- Reload and verify fix persists

---

### Lessons Learned (Phase 5 - Swarm Functionality)

**Design: Atomic multi-file transformation**
- The swarm takes a validated transformation (tested in REPL) and applies it across all matching locations in one transaction
- Key primitive for "scale across codebase" use case from DESIGN.md
- Version tracking enables detecting concurrent modifications

**Use case: Security audit at scale**
- Find all unguarded entry points via graph query
- Draft validator in REPL, test red→green
- Swarm inserts validator at every unguarded path atomically
- No partially-patched state possible

**Performance: 50 functions across 10 files in 7ms**
- Transformation is just string manipulation per file
- SQLite transaction ensures atomicity
- Can scale to thousands of files/files

---

### Lessons Learned (Phase 6 - CDP Integration)

**Design: Browser runtime as peer to server REPL**
- CDP extends the five-layer feedback loop: CST → LSP → REPL → CDP → OTel traces
- Enables full-stack traceability from server execution through browser rendering
- Key primitive for SSR hydration mismatch debugging and dead CSS detection

**Use case: Dead CSS elimination with certainty**
- Query all CSS selectors via `captureCssMatches`
- Find selectors with zero matches across real user journeys
- Remove dead CSS with confidence - not just unused, but never matched
- Combines with trace data to understand when CSS was last used

**Use case: SSR hydration mismatch detection**
- Capture server HTML before JS execution
- Wait for client-side hydration
- Diff outputs to locate exact mismatch position
- Join with symbol graph to identify responsible symbols

**Technical: Puppeteer CDP API changes**
- Puppeteer v24 changed several APIs (`headless`, `setTimeout`, `waitForTimeout`)
- Use `as any` casts for browser-context evaluate functions (DOM types not in TS lib)
- Template strings for evaluate work but need careful escaping
- Browser caching improves performance across multiple sessions

**Performance: 3 CSS selectors captured, 1 dead detected instantly**
- CSS match capture is just a DOM query in browser context
- Can scale to hundreds of selectors without performance issues
- Combined with trace data enables "when was this CSS last used" queries