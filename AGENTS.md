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