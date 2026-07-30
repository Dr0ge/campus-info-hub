import { config } from "./config";
import { normalizeSse, preFilterSse, type InternalMessage, type SseMessageEvent } from "./normalize";
import { isMessageProcessed, getEnabledSessions, insertRawMessage } from "./db";
import { setStatus } from "./server";

const API_BASE = config.weflow.baseUrl;
const TOKEN = config.weflow.token;
const SSE_URL = `${API_BASE}/api/v1/push/messages`;

type BatchHandler = (batch: InternalMessage[]) => void;

// Cache enabled sessions, refreshed every 60s or on-demand
let enabledTalkers = new Set<string>();
let lastRefresh = 0;

export function invalidateSessionCache() {
  lastRefresh = 0;
}

function isSessionEnabled(sessionId: string): boolean {
  const now = Date.now();
  if (now - lastRefresh > 60000) {
    const rows = getEnabledSessions();
    enabledTalkers = new Set(rows.map(r => r.talker));
    lastRefresh = now;
  }
  return enabledTalkers.has(sessionId);
}

class BatchBuffer {
  private buffer: InternalMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onFlush: BatchHandler;

  constructor(onFlush: BatchHandler) {
    this.onFlush = onFlush;
  }

  add(msg: InternalMessage) {
    this.buffer.push(msg);
    if (this.buffer.length >= config.batch.maxCount) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), config.batch.timeoutMs);
    }
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length > 0) {
      const batch = this.buffer.splice(0);
      this.onFlush(batch);
    }
  }
}

export class SseClient {
  private abortController: AbortController | null = null;
  private reconnectAttempt = 0;
  private running = false;
  private onBatch: BatchHandler;
  private batchBuffer: BatchBuffer;

  constructor(onBatch: BatchHandler) {
    this.onBatch = onBatch;
    this.batchBuffer = new BatchBuffer((batch) => {
      console.log(`[sse] 推送 ${batch.length} 条消息`);
      onBatch(batch);
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    this.abortController?.abort();
    this.batchBuffer.flush();
    setStatus({ weflow: "offline" });
  }

  private async connect() {
    if (!this.running) return;
    this.abortController = new AbortController();

    setStatus({ weflow: "reconnecting" });
    console.log(`[sse] 连接中... (第 ${this.reconnectAttempt + 1} 次)`);

    try {
      const res = await fetch(SSE_URL, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: this.abortController.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE 连接失败: ${res.status}`);
      }

      setStatus({ weflow: "online", lastSync: new Date().toISOString() });
      console.log("[sse] 已连接");
      this.reconnectAttempt = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6)) as SseMessageEvent;
              this.handleEvent(event);
            } catch { /* skip unparseable */ }
          }
        }
      }

      console.log("[sse] 流结束");
    } catch (err: any) {
      if (err.name === "AbortError") return;
      console.error(`[sse] 连接错误: ${err.message}`);
    }

    // Reconnect with backoff
    if (this.running) {
      const delay = Math.min(
        config.sse.reconnectInitialMs * Math.pow(2, this.reconnectAttempt),
        config.sse.reconnectMaxMs
      );
      const jitter = delay * (0.75 + Math.random() * 0.5);
      this.reconnectAttempt++;
      console.log(`[sse] ${Math.round(jitter)}ms 后重连`);
      await new Promise(r => setTimeout(r, jitter));
      this.connect();
    }
  }

  private handleEvent(event: SseMessageEvent) {
    if (!preFilterSse(event)) return;
    const msgId = `sse:${event.rawid}`;
    if (isMessageProcessed(msgId)) return;

    const msg = normalizeSse(event);

    // Only process messages from enabled sessions
    if (!isSessionEnabled(event.sessionId)) {
      console.log(`[sse] 跳过未启用群聊: ${event.groupName || event.sessionId}`);
      return;
    }

    // Store raw message for local context lookup
    insertRawMessage(msg.msgId, msg.sessionId, msg.groupName,
      msg.senderName, msg.content, msg.timestamp);
    this.batchBuffer.add(msg);
  }
}
