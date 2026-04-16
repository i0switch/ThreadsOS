import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "./index.js";

const MIGRATIONS_DIR = resolve(process.cwd(), "src", "db", "migrations");
const MIGRATION_TABLE = "__threadsos_migrations";

function splitStatements(fileContents: string): string[] {
  return fileContents
    .split(/;\s*(?:\r?\n|$)/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function isIgnorableMigrationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("duplicate column name") ||
    message.includes("no such table") ||
    message.includes("already exists") ||
    message.includes("unique constraint failed")
  );
}

const sqlite = (
  db as typeof db & {
    $client: {
      exec: (query: string) => void;
      prepare: (query: string) => {
        all: () => Array<{ filename: string }>;
        run: (...params: unknown[]) => void;
      };
    };
  }
).$client;

sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
    filename TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL
  )`);

const appliedRows = sqlite
  .prepare(`SELECT filename FROM ${MIGRATION_TABLE}`)
  .all() as Array<{ filename: string }>;
const applied = new Set(appliedRows.map((row) => row.filename));
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

for (const file of migrationFiles) {
  if (applied.has(file)) {
    continue;
  }

  const contents = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
  const statements = splitStatements(contents);

  for (const statement of statements) {
    try {
      sqlite.exec(statement);
    } catch (error) {
      if (!isIgnorableMigrationError(error)) {
        throw error;
      }
    }
  }

  sqlite
    .prepare(
      `INSERT OR REPLACE INTO ${MIGRATION_TABLE} (filename, applied_at) VALUES (?, ?)`,
    )
    .run(file, new Date().toISOString());
  console.log(`Applied migration: ${file}`);
}

console.log("Migration complete");
