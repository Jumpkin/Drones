import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createPool } from "./database.js";

export async function migrate(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  try {
    const names = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) await pool.query(await readFile(join(migrationDirectory, name), "utf8"));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate(loadConfig().databaseUrl).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
