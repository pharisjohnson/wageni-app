// Generates convex/_generated/* without a Convex deployment, using the same
// templates `npx convex dev` uses. Only needed before a deployment exists
// (e.g. fresh clones running tests in CI). Once `npx convex dev` runs, it
// overwrites these files with its own output.
//
//   node scripts/convex-codegen-offline.mjs
import { readdirSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

const require = createRequire(import.meta.url);
// The templates are internal to the convex package (not in its "exports"),
// so resolve them by file path from the package root.
const convexRoot = dirname(require.resolve("convex/package.json", { paths: [process.cwd()] }));
const templates = (name) =>
  require(join(convexRoot, "dist", "cjs", "cli", "codegen_templates", `${name}.js`));
const { apiCodegen } = templates("api");
const { serverCodegen } = templates("server");
const { header } = templates("common");

// Mirrors convex's dynamic data model template (its module imports the
// bundler, which needs optional dependencies, so it is inlined here).
const DATA_MODEL_DTS = `${header("Generated data model types.")}
import type { DataModelFromSchemaDefinition, DocumentByName, TableNamesInDataModel, SystemTableNames } from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

/** The names of all of your Convex tables. */
export type TableNames = TableNamesInDataModel<DataModel>;

/** The type of a document stored in Convex. */
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;

/** An identifier for a document in Convex. */
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;

/** A type describing your Convex data model. */
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
`;

const convexDir = join(process.cwd(), "convex");
const EXCLUDED = new Set(["schema.ts", "auth.config.ts", "convex.config.ts"]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "_generated" ? [] : walk(full);
    if (!/\.(ts|js)$/.test(name) || name.endsWith(".d.ts") || /\.test\./.test(name)) return [];
    if (EXCLUDED.has(relative(convexDir, full))) return [];
    return [relative(convexDir, full).split(sep).join("/")];
  });
}

const modulePaths = walk(convexDir).sort();
const outDir = join(convexDir, "_generated");
mkdirSync(outDir, { recursive: true });

const api = apiCodegen(modulePaths, { useTypeScript: false });
const server = serverCodegen({ useTypeScript: false });
writeFileSync(join(outDir, "api.d.ts"), api.DTS);
writeFileSync(join(outDir, "api.js"), api.JS);
writeFileSync(join(outDir, "server.d.ts"), server.DTS);
writeFileSync(join(outDir, "server.js"), server.JS);
writeFileSync(join(outDir, "dataModel.d.ts"), DATA_MODEL_DTS);

console.log(`Generated convex/_generated for ${modulePaths.length} modules.`);
