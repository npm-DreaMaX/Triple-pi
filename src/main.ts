#!/usr/bin/env node
/**
 * Triple-pi — Entry Point
 *
 * Starts a Pi-powered coding agent with Triple-pi's persistent memory layer.
 *
 * Architecture:
 *   User (Terminal/Slack/Web)
 *     → Triple-pi entry point (this file)
 *       → Pi SDK createAgentSession()
 *         → Pi Agent Loop (unchanged, used as Runtime)
 *           → LLM with Triple-pi tools + memory context
 *
 * Pi provides: Agent Loop, Tool Execution, LLM abstraction, Session management
 * Triple-pi adds: Persistent Memory (SaveMemory + SearchMemory tools, MEMORY.md index)
 *
 * ============================================================================
 * INTEGRATION POINT
 * ============================================================================
 *
 * We integrate with Pi at THREE points, all through public SDK API:
 *
 * 1. System Prompt: We pass a custom DefaultResourceLoader to createAgentSession.
 *    DefaultResourceLoader accepts appendSystemPromptOverride — this is where
 *    the memory index is injected after Pi's built-in system prompt.
 *
 * 2. Custom Tools: SaveMemory and SearchMemory are passed via customTools option.
 *    They appear in the tool-use loop just like Read/Write/Bash.
 *
 * 3. Filesystem: Memory files live at ~/.triple-pi/memory/.
 *    The agent accesses them with Pi's standard Read tool.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { ensureMemoryDir, buildMemorySystemPrompt } from './memory/index.js';
import { saveMemoryTool } from './tools/save-memory.js';
import { searchMemoryTool } from './tools/search-memory.js';

async function main(): Promise<void> {
  // 1. Ensure memory storage is ready
  ensureMemoryDir();

  // 2. Build the memory section of the system prompt
  const memoryPrompt = buildMemorySystemPrompt();
  console.log('[triple-pi] Memory prompt built (%d chars)', memoryPrompt.length);

  // 3. Create a custom ResourceLoader that injects memory into the system prompt.
  //    DefaultResourceLoader is Pi's built-in loader (handles AGENTS.md, skills,
  //    themes, etc.). We pass appendSystemPromptOverride to add memory content
  //    AFTER Pi's own system prompt is assembled.
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.env.HOME + '/.pi/agent',
    appendSystemPromptOverride: (base: string[]) => {
      return [...base, memoryPrompt];
    },
  });
  await resourceLoader.reload();

  // 4. Register memory tools
  const customTools: ToolDefinition[] = [saveMemoryTool, searchMemoryTool];

  // 5. Create Pi agent session with our enhancements
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    resourceLoader,
    customTools,
  });

  console.log('[triple-pi] Agent session created');
  console.log('[triple-pi] Memory root: ~/.triple-pi/memory/');

  // The session is now ready. In interactive mode, Pi's TUI handles input.
  // For programmatic use:
  //   await session.prompt("your message");
}

main().catch((err) => {
  console.error('[triple-pi] Fatal error:', err);
  process.exit(1);
});
