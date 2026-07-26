#!/usr/bin/env node

console.error([
  "The legacy LLM eval is disabled as a release signal.",
  "Its assertions can report false positives and it does not exercise the new memory repository or Pi lifecycle.",
  "Use npm test for deterministic Block 1 verification.",
  "The live product eval will be rebuilt in Block 6; npm run eval:legacy remains available for historical comparison only.",
].join("\n"));
process.exitCode = 1;
