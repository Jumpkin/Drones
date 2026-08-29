import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./database.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp(pool, config, { logger: true });

const stop = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await app.listen({ host: config.host, port: config.port });
