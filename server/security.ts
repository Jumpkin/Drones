import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function issueCapability(): string {
  return randomBytes(32).toString("base64url");
}

export function hashCapability(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token, "utf8").digest("hex");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function containsRawAudio(payload: unknown, visited = new WeakSet<object>()): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (ArrayBuffer.isView(payload) || payload instanceof ArrayBuffer) return true;
  if (visited.has(payload)) return false;
  visited.add(payload);
  return Object.entries(payload as Record<string, unknown>).some(([key, value]) => {
    if (/audio|pcm|samples|wav|blob|base64/i.test(key)) return true;
    return value && typeof value === "object" ? containsRawAudio(value, visited) : false;
  });
}
