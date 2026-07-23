/**
 * SaveMemory Tool
 *
 * Registered with Pi's tool system via `customTools` in createAgentSession().
 * Enables the agent to persist important information to long-term memory.
 *
 * DESIGN: When should the agent call this tool?
 *   1. The user explicitly asks ("记住这个", "remember this")
 *   2. A significant technical decision is made (architecture choice)
 *   3. A new project rule is established
 *
 * We deliberately do NOT auto-extract memories. This follows OpenClaw's
 * principle: "only grounded snippets enter long-term memory."
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { saveMemory } from '../memory/index.js';
import type { MemoryCategory } from '../memory/types.js';
import { CATEGORY_GUIDELINES } from '../memory/types.js';

export const saveMemoryTool: ToolDefinition = {
  name: 'SaveMemory',
  label: 'Save Memory',

  description:
    '将重要信息持久化到长期记忆，跨会话保留。' +
    '仅在用户明确要求"记住这个"时使用，或做出重要技术决策后使用。' +
    '不要记录临时信息、调试过程、或日常对话。' +
    '\n\n各分类说明：\n' +
    Object.entries(CATEGORY_GUIDELINES)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n'),

  promptSnippet: 'save a fact, preference, decision, or rule to persistent memory',

  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['preference', 'decision', 'rule', 'fact'],
        description: '记忆分类',
      },
      title: {
        type: 'string',
        description: '简短标题，不超过 50 字。会出现在记忆索引中。',
      },
      content: {
        type: 'string',
        description:
          '记忆内容（Markdown 格式）。应包含：1) 具体信息 2) 上下文（为什么）3) 适用场景',
      },
    },
    required: ['category', 'title', 'content'],
  },

  async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
    const { category, title, content } = params;

    if (!['preference', 'decision', 'rule', 'fact'].includes(category)) {
      return {
        content: [{ type: 'text', text: `无效分类 "${category}"。有效值：preference, decision, rule, fact` }],
        details: {},
      };
    }

    try {
      const filepath = saveMemory(category as MemoryCategory, title, content);
      return {
        content: [{
          type: 'text',
          text: `✅ 已记住："${title}"\n分类：${category}\n文件：${filepath}\n\n这条记忆将在后续会话中自动加载。`,
        }],
        details: { filepath, category, title },
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `保存记忆失败：${error instanceof Error ? error.message : String(error)}`,
        }],
        details: {},
      };
    }
  },
};
