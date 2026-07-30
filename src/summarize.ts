import { config } from "./config";
import type { ItemRow } from "./db";

const SYSTEM_PROMPT = `你是一个校园信息播报助手。给定过去24小时内筛选出的有价值信息列表，请生成一段简洁的中文摘要。

要求：
- 按类别归纳（活动通知、社团招新、学术、二手、实习等）
- 突出最重要的2-3条信息
- 用自然语言表述，像新闻简报一样
- 总字数控制在200字以内
- 如果有某类信息完全没有，就不提该类
- 输出纯文本，不要markdown格式`;

export async function generateDigest(items: ItemRow[]): Promise<string> {
  if (items.length === 0) return "过去24小时内暂无值得关注的信息。";

  // Build a compact summary of items for the model
  const itemList = items.map((item, i) =>
    `[${i}] [${item.category}] ${item.title}（来源：${item.source_group}）`
  ).join("\n");

  const payload = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `以下是过去24小时筛选出的 ${items.length} 条信息：\n\n${itemList}\n\n请生成摘要。` },
    ],
    temperature: 0.5,
    max_tokens: 400,
  };

  console.log(`[summarize] Generating digest for ${items.length} items...`);

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
  return content?.trim() || "（摘要生成失败）";
}
