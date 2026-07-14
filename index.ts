#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "./src/db.ts";
import { discoverTypeScriptFiles, findReferences, indexWorkspace, searchSymbols } from "./src/semantic-index.ts";

const [command = "index", argument] = process.argv.slice(2);
const root = resolve(process.env.GROVE_ROOT ?? process.cwd());
mkdirSync(resolve(root, ".grove"), { recursive: true });
const database = await createDatabase(resolve(root, ".grove/index.db"));

try {
  switch (command) {
    case "index":
      console.log(JSON.stringify(indexWorkspace(database, root, discoverTypeScriptFiles(root)), null, 2));
      break;
    case "symbols":
      if (!argument) throw new Error("Usage: grove symbols <exact-name>");
      console.log(JSON.stringify(searchSymbols(database, argument), null, 2));
      break;
    case "references":
      if (!argument) throw new Error("Usage: grove references <symbol-id>");
      console.log(JSON.stringify(findReferences(database, argument), null, 2));
      break;
    default:
      throw new Error("Usage: grove [index | symbols <name> | references <symbol-id>]");
  }
} finally {
  database.close();
}
