import type { AppConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(): AppConfig {
  const setupCode = required("DRONES_SETUP_CODE");
  const tokenPepper = required("DRONES_TOKEN_PEPPER");
  if (setupCode.length < 8) throw new Error("DRONES_SETUP_CODE must contain at least 8 characters");
  if (tokenPepper.length < 32) throw new Error("DRONES_TOKEN_PEPPER must contain at least 32 characters");
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? "120");
  if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1 || rateLimitMax > 10_000) {
    throw new Error("RATE_LIMIT_MAX is invalid");
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    setupCode,
    tokenPepper,
    host: process.env.HOST?.trim() || "0.0.0.0",
    port,
    staticDir: process.env.STATIC_DIR?.trim() || undefined,
    rateLimitMax,
  };
}
