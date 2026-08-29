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
