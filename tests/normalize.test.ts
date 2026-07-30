import { describe, it, expect } from "bun:test";
import { normalizeRest, preFilterRest } from "../src/normalize";

describe("normalizeRest", () => {
  it("normalizes a REST message with session info", () => {
    const restMsg = {
      localId: 100,
      serverId: "svr001",
      localType: 1,
      createTime: 1785303489,
      sortSeq: 1785303489000,
      isSend: 0,
      senderUsername: "wxid_abc",
      content: "测试消息",
      rawContent: "wxid_abc:\n测试消息",
      parsedContent: "",
    };
    const msg = normalizeRest(restMsg, "123@chatroom", "测试群");
    expect(msg.msgId).toBe("rest:svr001");
    expect(msg.groupName).toBe("测试群");
    expect(msg.content).toBe("测试消息");
    expect(msg.senderId).toBe("wxid_abc");
    expect(msg.senderName).toBe("wxid_abc"); // no contacts map → falls back to wxid
  });

  it("resolves sender display name from contacts map", () => {
    const restMsg = {
      localId: 1, serverId: "s1", localType: 1, createTime: 0, sortSeq: 0, isSend: 0,
      senderUsername: "wxid_abc", content: "你好", rawContent: "", parsedContent: "",
    };
    const contacts = new Map([["wxid_abc", "张三"]]);
    const msg = normalizeRest(restMsg, "g1@chatroom", "群1", contacts);
    expect(msg.senderName).toBe("张三");
  });
});

describe("preFilterRest", () => {
  it("rejects non-text messages (localType != 1)", () => {
    const msg = { localId: 1, serverId: "1", localType: 999, createTime: 0, sortSeq: 0, isSend: 0, senderUsername: null, content: "xxx", rawContent: "", parsedContent: "" };
    expect(preFilterRest(msg)).toBe(false);
  });

  it("rejects too-short text (< 5 chars)", () => {
    const msg = { localId: 1, serverId: "1", localType: 1, createTime: 0, sortSeq: 0, isSend: 0, senderUsername: "a", content: "嗯", rawContent: "", parsedContent: "" };
    expect(preFilterRest(msg)).toBe(false);
  });

  it("rejects empty content", () => {
    const msg = { localId: 1, serverId: "1", localType: 1, createTime: 0, sortSeq: 0, isSend: 0, senderUsername: "a", content: "", rawContent: "", parsedContent: "" };
    expect(preFilterRest(msg)).toBe(false);
  });

  it("rejects [消息] placeholder", () => {
    const msg = { localId: 1, serverId: "1", localType: 1, createTime: 0, sortSeq: 0, isSend: 0, senderUsername: "a", content: "[消息]", rawContent: "", parsedContent: "" };
    expect(preFilterRest(msg)).toBe(false);
  });

  it("accepts valid text messages", () => {
    const msg = { localId: 1, serverId: "1", localType: 1, createTime: 0, sortSeq: 0, isSend: 0, senderUsername: "a", content: "明天下午3点讲座", rawContent: "", parsedContent: "" };
    expect(preFilterRest(msg)).toBe(true);
  });
});
