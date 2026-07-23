/**
 * SearchMemory Tool
 *
 * Full-text search across all persistent memory files.
 * The agent uses this when it needs to recall past preferences,
 * decisions, or rules but doesn't know which specific file to read.
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { searchMemory } from '../memory/index.js';

export const searchMemoryTool: ToolDefinition = {
  name: 'SearchMemory',
  label: 'Search Memory',

  description:
    '在持久化记忆中搜索关键词。当你需要回忆用户之前的偏好、决策或项目规则时使用。',

  promptSnippet: 'search persistent memory by keyword',

  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '搜索关键词。支持英文和中文。全文不区分大小写匹配。',
      },
    },
    required: ['keyword'],
  },

  async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
    const { keyword } = params;

    if (!keyword || keyword.trim().length === 0) {
      return {
        content: [{ type: 'text', text: '请提供搜索关键词。' }],
        details: {},
      };
    }

    try {
      const results = searchMemory(keyword.trim());

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `未找到与 "${keyword}" 相关的记忆。\n提示：尝试更短的关键词，或浏览 ~/.triple-pi/memory/ 目录。`,
          }],
          details: { keyword, count: 0 },
        };
      }

      const formatted = results
        .map((r, i) =>
          `### ${i + 1}. ${r.entry.title}\n` +
          `**分类**: ${r.entry.category} | **更新**: ${r.entry.updatedAt}\n` +
          `**文件**: ${r.entry.path}\n\n${r.entry.content}`
        )
        .join('\n\n---\n\n');

      return {
        content: [{
          type: 'text',
          text: `找到 ${results.length} 条与 "${keyword}" 相关的记忆：\n\n${formatted}`,
        }],
        details: { keyword, count: results.length },
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `搜索记忆失败：${error instanceof Error ? error.message : String(error)}`,
        }],
        details: {},
      };
    }
  },
};
