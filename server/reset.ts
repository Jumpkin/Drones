import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createPool } from "./database.js";

export async function resetDisposableDatabase(databaseUrl: string): Promise<void> {
  if (process.env.DRONES_ALLOW_RESET !== "true" ||
      !process.argv.includes("--confirm-disposable-drones-data")) {
    throw new Error("Reset refused: set DRONES_ALLOW_RESET=true and pass --confirm-disposable-drones-data");
  }
  const pool = createPool(databaseUrl);
  try {
    await pool.query(
      `TRUNCATE TABLE drones_observations, drones_playbacks,
       drones_session_memberships, drones_sessions, drones_devices CASCADE`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  resetDisposableDatabase(loadConfig().databaseUrl).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
