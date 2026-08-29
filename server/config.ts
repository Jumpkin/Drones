import type { AppConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? "120");
  if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1 || rateLimitMax > 10_000) {
    throw new Error("RATE_LIMIT_MAX is invalid");
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    host: process.env.HOST?.trim() || "0.0.0.0",
    port,
    staticDir: process.env.STATIC_DIR?.trim() || undefined,
    rateLimitMax,
  };
}
