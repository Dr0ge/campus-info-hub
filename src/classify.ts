import { config } from "./config";
import type { InternalMessage } from "./normalize";

const SYSTEM_PROMPT = `你是一个校园信息筛选助手。输入是一批微信群聊天记录，按群分组。判断每条消息是否包含实质性的有用信息，属于以下类型：
- 活动通知：讲座、比赛、演出、聚会、社团活动等（需有时间/地点/主题等具体信息）
- 社团招新：社团/学生组织明确招募新成员（需有社团名或联系方式）
- 学术相关：课程安排、考试通知、竞赛报名、学习资料分享等（需有具体内容）
- 二手交易/失物招领：明确的买卖/求购/寻物/招领意图
- 实习/校招：招聘信息、内推、实习机会

严格排除以下内容（标记为闲聊/其他）：
- 日常寒暄、吐槽、表情包、个人状态分享
- 模糊提问（如"可以买二手吗"但没有具体求购信息）
- 一句话的简单问答（如"几点放学""半天吧"）
- 单纯的闲聊讨论而非通知/公告

有价值的信息需提取：标题(summary)、时间(date)、地点(loc)、主办方/来源(org)、原文引用(quote)。

宁可漏报疑似内容，不可把闲聊当有用信息。输出严格JSON数组：
[{"g":0,"i":0,"r":true,"cat":"社团招新","summary":"摄影社招新面试","date":"下周三下午3点","loc":"体育馆门口","org":"28届摄影社","quote":"摄影社下周三下午3点在体育馆门口招新面试，有单反的同学优先~"},{"g":0,"i":1,"r":false,"cat":"闲聊/其他"}]`;

export interface ClassifyResult {
  groupIndex: number;
  msgIndex: number;
  relevant: boolean;
  category: string;
  summary?: string;
  date?: string;
  loc?: string;
  org?: string;
  quote?: string;
}

// ── Build compact prompt ──

interface GroupedMessages {
  groupName: string;
  messages: { index: number; senderName: string; content: string; timestamp: number }[];
}

function groupMessages(messages: InternalMessage[]): GroupedMessages[] {
  const groups = new Map<string, GroupedMessages>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const key = msg.groupName || msg.sessionId;
    if (!groups.has(key)) {
      groups.set(key, { groupName: key, messages: [] });
    }
    groups.get(key)!.messages.push({
      index: i,
      senderName: msg.senderName || "未知",
      content: msg.content,
      timestamp: msg.timestamp,
    });
  }

  return Array.from(groups.values());
}

function buildUserMessage(groups: GroupedMessages[]): string {
  const parts: string[] = [];
  groups.forEach((group, gi) => {
    const lines = [`群${gi}: ${group.groupName}`];
    group.messages.forEach((msg) => {
      const cleanContent = msg.content.replace(/\n/g, " ").trim();
      const time = formatTime(msg.timestamp);
      lines.push(`${msg.index}: [${time}] ${msg.senderName}: ${cleanContent}`);
    });
    parts.push(lines.join("\n"));
  });
  return parts.join("\n\n");
}

function formatTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${MM}-${DD} ${HH}:${mm}`;
}

// ── Call DeepSeek ──

export async function classifyBatch(messages: InternalMessage[]): Promise<ClassifyResult[]> {
  if (messages.length === 0) return [];

  const groups = groupMessages(messages);
  const userMessage = buildUserMessage(groups);

  const payload = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  };

  console.log(`[classify] Sending ${messages.length} msgs in ${groups.length} groups to DeepSeek...`);

  const res = await fetch(`${config.deepseek.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.deepseek.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("DeepSeek returned empty response");
  }

  // Parse the JSON array from the response
  const results = parseResponse(content);
  console.log(`[classify] Got ${results.filter(r => r.relevant).length}/${results.length} relevant`);
  return results;
}

// ── Parse DeepSeek response ──

function parseResponse(content: string): ClassifyResult[] {
  // Extract JSON array from response (may be wrapped in markdown code block)
  let json = content.trim();
  if (json.startsWith("```")) {
    json = json.replace(/```json?\n?/g, "").replace(/```\n?/g, "").trim();
  }
  // Find the array start
  const arrStart = json.indexOf("[");
  const arrEnd = json.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    json = json.substring(arrStart, arrEnd + 1);
  }

  try {
    const raw = JSON.parse(json) as any[];
    return raw.map((item) => ({
      groupIndex: item.g ?? 0,
      msgIndex: item.i ?? 0,
      relevant: item.r ?? false,
      category: item.cat || "闲聊/其他",
      summary: item.summary || undefined,
      date: item.date || undefined,
      loc: item.loc || undefined,
      org: item.org || undefined,
      quote: item.quote || undefined,
    }));
  } catch (err) {
    console.error("[classify] Failed to parse DeepSeek response:", json.substring(0, 200));
    // Fallback: treat as all irrelevant
    console.error("[classify] Falling back to all-irrelevant");
    return [];
  }
}
