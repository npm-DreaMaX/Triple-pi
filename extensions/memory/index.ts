/**
 * Triple-pi Memory Extension
 *
 * Pi auto-discovers and loads this extension from .pi/extensions/memory/.
 * Registers SaveMemory + SearchMemory tools with Pi's native tool system.
 *
 * To install: ln -s ~/Triple-pi/extensions/memory ~/.pi/agent/extensions/memory
 *
 * DESIGN (OpenClaw-inspired async extraction):
 *   SaveMemory is restricted — it prompts the agent to verify with the user
 *   before saving. The primary memory source is the post-session extractor
 *   (npm run extract), which scans transcripts and extracts grounded memories.
 *   This prevents LLM over-calling during conversation.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { save, search } from "./storage";

// ── SaveMemory ──────────────────────────────────────────────

const saveMemoryTool = defineTool({
  name: "SaveMemory",
  label: "Save Memory",
  description: [
    "将重要信息持久化到长期记忆，跨会话保留。",
    "",
    "⚠️ 仅在以下情况使用：",
    "1. 用户明确说\"记住这个\"、\"别忘了\"、\"下次记得\"等",
    "2. 用户直接要求保存某条信息",
    "",
    "🚫 不要使用：",
    "- 用户只是在测试或询问工具功能",
    "- 临时调试信息、中间过程",
    "- 普通的日常对话",
    "- 不确定是否值得记住的内容",
    "",
    "不确定时，问用户：\"需要我记住这个吗？\"",
  ].join("\n"),
  promptSnippet: "save important info to persistent memory (user must explicitly ask)",
  parameters: Type.Object({
    category: Type.String({
      description: "记忆分类：preference=偏好, decision=决策, rule=规则, fact=事实",
    }),
    title: Type.String({ description: "简短标题" }),
    content: Type.String({ description: "记忆内容（含原因和适用场景）" }),
  }),
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const { category, title, content } = params as {
      category: string;
      title: string;
      content: string;
    };
    const valid = ["preference", "decision", "rule", "fact", "knowledge"];
    if (!valid.includes(category)) {
      return {
        content: [{ type: "text", text: `无效分类 "${category}"。有效值：${valid.join(", ")}` }],
        details: {},
      };
    }
    try {
      const fp = save(category as any, title, content);
      return {
        content: [{ type: "text", text: `✅ 已记住："${title}"\n文件：${fp}\n后续会话自动加载。` }],
        details: { filepath: fp, category, title },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `保存失败：${err.message}` }],
        details: {},
      };
    }
  },
});

// ── SearchMemory ────────────────────────────────────────────

const searchMemoryTool = defineTool({
  name: "SearchMemory",
  label: "Search Memory",
  description: "在持久化记忆中搜索关键词。用于回忆之前的偏好、决策或规则。",
  promptSnippet: "search persistent memory by keyword",
  parameters: Type.Object({
    keyword: Type.String({ description: "搜索关键词" }),
  }),
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const { keyword } = params as { keyword: string };
    const results = search(keyword.trim());
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `未找到与 "${keyword}" 相关的记忆。` }],
        details: { keyword, count: 0 },
      };
    }
    const fmt = results
      .map((r, i) => `### ${i + 1}. ${r.entry.title}\n**分类**: ${r.entry.category}\n\n${r.entry.content}`)
      .join("\n\n---\n\n");
    return {
      content: [{ type: "text", text: `找到 ${results.length} 条与 "${keyword}" 相关的记忆：\n\n${fmt}` }],
      details: { keyword, count: results.length },
    };
  },
});

// ── Extension entry ─────────────────────────────────────────

export default function memoryExtension(pi: ExtensionAPI) {
  pi.registerTool(saveMemoryTool);
  pi.registerTool(searchMemoryTool);
}
