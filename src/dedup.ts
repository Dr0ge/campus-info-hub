import { config } from "./config";
import { getAllItemTexts, mergeSourceGroup } from "./db";

// ── In-memory cache of existing items ──

interface CachedItem {
  id: string;
  title: string;
  description: string;
}

let cache: CachedItem[] = [];
let cacheLoaded = false;

function loadCache() {
  if (cacheLoaded) return;
  const items = getAllItemTexts();
  cache = items.map((i) => ({ id: i.id, title: i.text.split(" ")[0] || "", description: i.text }));
  cacheLoaded = true;
}

export function addToCache(id: string, title: string, description: string) {
  cache.push({ id, title, description });
}

// ── Title overlap pre-filter ──

function titleOverlap(a: string, b: string): number {
  const setA = new Set(a.replace(/\s/g, ""));
  const setB = new Set(b.replace(/\s/g, ""));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersect = 0;
  for (const ch of setA) {
    if (setB.has(ch)) intersect++;
  }
  return intersect / Math.min(setA.size, setB.size);
}

// ── DeepSeek semantic dedup ──

const JUDGE_PROMPT = `你是一个信息去重助手。判断以下两条消息是否描述的是同一件事（如同一活动、同一社团招新、同一交易等）。

注意：
- 措辞不同但实质相同 → 是同一件事
- 同一社团的不同招新帖 → 可能不同（看时间和内容是否一致）
- 同一活动的不同通知 → 是同一件事

请只回复一个JSON：{"same": true} 或 {"same": false}`;

async function askDeepSeek(a: CachedItem, b: { title: string; description: string }): Promise<boolean> {
  const payload = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: JUDGE_PROMPT },
      {
        role: "user",
        content: `消息A：\n标题：${a.title}\n内容：${a.description}\n\n消息B：\n标题：${b.title}\n内容：${b.description}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 50,
  };

  const res = await fetch(`${config.deepseek.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.deepseek.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`[dedup] DeepSeek API error: ${res.status}`);
    return false; // On error, assume not duplicate (safe side)
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  try {
    const json = JSON.parse(content.trim());
    return json.same === true;
  } catch {
    return false;
  }
}

// ── Main dedup check ──

export interface DedupResult {
  isDuplicate: boolean;
  similarToId?: string;
}

export async function checkDedup(
  title: string,
  description: string,
  sourceGroup: string
): Promise<DedupResult> {
  loadCache();

  // Find best candidate by title overlap
  let bestCandidate: CachedItem | null = null;
  let bestScore = 0;

  for (const item of cache) {
    const score = titleOverlap(item.title, title);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = item;
    }
  }

  // Only invoke DeepSeek if title overlap suggests plausible match
  if (bestCandidate && bestScore >= 0.3) {
    console.log(`[dedup] Candidate: "${bestCandidate.title}" vs "${title}" (overlap: ${(bestScore * 100).toFixed(0)}%)`);
    const same = await askDeepSeek(bestCandidate, { title, description });
    if (same) {
      console.log(`[dedup] DeepSeek: SAME → merging source "${sourceGroup}" into ${bestCandidate.id}`);
      mergeSourceGroup(bestCandidate.id, sourceGroup);
      return { isDuplicate: true, similarToId: bestCandidate.id };
    }
    console.log(`[dedup] DeepSeek: DIFFERENT`);
  }

  return { isDuplicate: false };
}
