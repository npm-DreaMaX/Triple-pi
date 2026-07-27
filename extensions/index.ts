/**
 * triple-pi Unified Extension Entry
 *
 * 统一的扩展入口，同时注册 Memory 和 SubAgent (Reviewer) 扩展。
 * Pi Coding Agent 在加载 extensions/ 目录时自动调用此默认导出。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryExtension } from "./memory/index.ts";
import { createMemoryRepository } from "./memory/repository.ts";
import { registerSubagentExtension } from "./subagent/index.ts";

export default function triplePiExtension(pi: ExtensionAPI): void {
  const repository = createMemoryRepository();
  registerMemoryExtension(pi, repository);
  registerSubagentExtension(pi, repository);
}
