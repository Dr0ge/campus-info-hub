import { env } from "bun";

export const config = {
  weflow: {
    baseUrl: env.WEFLOW_API_BASE || "http://127.0.0.1:5031",
    token: env.WEFLOW_API_TOKEN || "",
  },
  deepseek: {
    baseUrl: env.DEEPSEEK_API_BASE || "https://api.deepseek.com",
    apiKey: env.DEEPSEEK_API_KEY || "",
  },
  poll: {
    intervalSec: Number(env.POLL_INTERVAL_SEC) || 300,
  },
  sse: {
    reconnectInitialMs: Number(env.SSE_RECONNECT_INITIAL_MS) || 1000,
    reconnectMaxMs: Number(env.SSE_RECONNECT_MAX_MS) || 60000,
  },
  batch: {
    maxCount: Number(env.BATCH_MAX_COUNT) || 100,
    timeoutMs: Number(env.BATCH_TIMEOUT_MS) || 180000,
  },
  dedup: {
    similarityThreshold: Number(env.DEDUP_SIMILARITY_THRESHOLD) || 0.6,
  },
  server: {
    port: Number(env.SERVER_PORT) || 3000,
  },
};
