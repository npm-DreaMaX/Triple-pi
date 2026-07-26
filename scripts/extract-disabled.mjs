#!/usr/bin/env node

console.error([
  "The legacy transcript extractor is disabled.",
  "It used an incompatible storage layout and bypassed Pi's session/provider APIs.",
  "Automatic extraction will return as a branch-aware Pi extension lifecycle in Block 3.",
].join("\n"));
process.exitCode = 1;
