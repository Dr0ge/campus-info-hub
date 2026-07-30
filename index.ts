import { getDb, insertItem, getRecentItems, saveDigest, markMessageProcessed, updateLastPollTime } from "./src/db";
import { poll } from "./src/poller";
import { classifyBatch } from "./src/classify";
import { checkDedup, addToCache } from "./src/dedup";
import { generateDigest } from "./src/summarize";
import type { InternalMessage } from "./src/normalize";
import { config } from "./src/config";
import { setStatus, onSyncRequest } from "./src/server";
import { SseClient } from "./src/sse-client";

getDb();
console.log("Database initialized");

import "./src/server";

// ── Message Pipeline ──

let storageLock = false;

/** Classify all batches in parallel, then store results sequentially */
async function processAllBatches(messages: InternalMessage[]) {
  if (messages.length === 0) return;

  const BATCH_SIZE = config.batch.maxCount;
  const batches: InternalMessage[][] = [];
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    batches.push(messages.slice(i, i + BATCH_SIZE));
  }

  // 1. Classify all batches in parallel (DeepSeek API calls)
  console.log(`[pipeline] 并行分类 ${batches.length} 批 (共 ${messages.length} 条)...`);
  const classifyStart = Date.now();
  const allResults = await Promise.all(
    batches.map(batch => classifyBatch(batch).catch(err => {
      console.error("[pipeline] 分类失败:", err);
      return [];
    }))
  );
  console.log(`[pipeline] 分类完成 (${Date.now() - classifyStart}ms)`);

  // 2. Store results sequentially (dedup + insert needs serialization)
  while (storageLock) await new Promise(r => setTimeout(r, 50));
  storageLock = true;

  try {
    let totalInserted = 0, totalDupes = 0, totalSkipped = 0;

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const results = allResults[bi];

      if (results.length === 0) {
        for (const msg of batch) markMessageProcessed(msg.msgId);
        continue;
      }

      const relevantResults = results.filter((r: any) => r.relevant);
      if (relevantResults.length === 0 && batch.length > 0) {
        console.log(`[pipeline] 批次${bi}: 全部 ${results.length} 条为闲聊，样本: [${batch[0].groupName}] ${batch[0].content.substring(0, 50)}`);
      }

      for (const result of results) {
        const msg = batch[result.msgIndex];
        if (!msg) continue;

        if (!result.relevant) {
          totalSkipped++;
          markMessageProcessed(msg.msgId);
          continue;
        }

        const title = result.summary || msg.content.substring(0, 50);
        const description = result.quote || msg.content;
        const sourceGroup = msg.groupName;

        console.log(`[pipeline] ✓ [${result.category}] "${title}" — ${sourceGroup}`);

        const dedupResult = await checkDedup(title, description, sourceGroup);
        if (dedupResult.isDuplicate) {
          totalDupes++;
          markMessageProcessed(msg.msgId);
          continue;
        }

        const id = insertItem({
          category: mapCategory(result.category),
          title,
          description,
          event_date: result.date || null,
          location: result.loc || null,
          organizer: result.org || null,
          sender_name: msg.senderName || null,
          source_quote: result.quote || msg.content,
          source_group: sourceGroup,
          source_msg_id: msg.msgId,
          session_id: msg.sessionId,
          msg_time: msg.timestamp,
          is_verified: 0,
          content_hash: "",
        });
        markMessageProcessed(msg.msgId);
        addToCache(id, title, description);
        totalInserted++;
      }
    }

    console.log(`[pipeline] 总计: ${totalInserted} 入库, ${totalDupes} 重复, ${totalSkipped} 闲聊`);
  } finally {
    storageLock = false;
  }
}

function mapCategory(cat: string): string {
  const m: Record<string, string> = {
    "活动通知": "活动通知", "社团招新": "社团招新", "学术相关": "学术",
    "二手交易/失物招领": "二手", "实习/校招": "实习", "闲聊/其他": "闲聊/其他",
  };
  return m[cat] || "闲聊/其他";
}

// ── Poll Cycle ──

let polling = false;

async function runPollCycle() {
  if (polling) { console.log("[poll] Already running, skipping"); return; }
  polling = true;

  console.log("[poll] Starting cycle...");
  try {
    const result = await poll();
    if (result.errors.length > 0) {
      setStatus({ lastError: result.errors[0] });
    }

    await processAllBatches(result.messages);
    updateLastPollTime(new Date().toISOString());

    if (result.messages.length > 0) {
      try {
        console.log("[poll] Generating digest...");
        const recentItems = getRecentItems(24);
        const digest = await generateDigest(recentItems);
        saveDigest(digest, recentItems.length);
      } catch (err) {
        console.error("[poll] Digest generation failed:", err);
      }
    }

    setStatus({ lastSync: new Date().toISOString(), lastError: "" });
  } catch (err) {
    console.error("[poll] Cycle error:", err);
    setStatus({ lastError: String(err) });
  } finally {
    polling = false;
  }
}

// ── Startup ──

async function startup() {
  onSyncRequest(runPollCycle);

  const sseClient = new SseClient((batch: InternalMessage[]) => {
    processAllBatches(batch);
  });
  sseClient.start();
  console.log("[startup] SSE 持续监听中");

  console.log("[startup] 初始回填...");
  await runPollCycle();

  process.on("SIGINT", () => {
    console.log("\n[startup] 关闭中...");
    sseClient.stop();
    process.exit(0);
  });
}

startup().catch((err) => {
  console.error("[startup] Fatal error:", err);
  process.exit(1);
});
