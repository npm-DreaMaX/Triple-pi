import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function quotedStrings(source: string): Set<string> {
  return new Set([...source.matchAll(/["']([A-Z][A-Z0-9_]+)["']/g)].map((match) => match[1]));
}

function unsetVariables(source: string): Set<string> {
  return new Set([...source.matchAll(/^\s*unset\s+([A-Z][A-Z0-9_]+)\s*$/gm)].map((match) => match[1]));
}

describe("launcher contracts", () => {
  it("the Unix launcher resolves symlinks without GNU realpath", () => {
    const source = readFileSync("bin/trip", "utf8");
    expect(source).toContain("readlink");
    expect(source).not.toMatch(/\$\(realpath\b/);
    execFileSync("bash", ["-n", "bin/trip"]);
  });

  it("the runtime shell launcher replaces itself with the Node process", () => {
    const source = readFileSync("pi-runtime/pi-test.sh", "utf8");
    expect(source).toMatch(/exec \"\$SCRIPT_DIR\/node_modules\/\.bin\/tsx\"/);
    execFileSync("bash", ["-n", "pi-runtime/pi-test.sh"]);
  });

  it("Bash and PowerShell clear every provider API-key environment variable", () => {
    const providerSource = readFileSync("pi-runtime/packages/ai/src/env-api-keys.ts", "utf8");
    const apiKeys = new Set(
      [...providerSource.matchAll(/["']([A-Z][A-Z0-9_]*(?:API_KEY|OAUTH_TOKEN))["']/g)]
        .map((match) => match[1]),
    );
    const bashKeys = unsetVariables(readFileSync("pi-runtime/pi-test.sh", "utf8"));
    const powershellKeys = quotedStrings(readFileSync("pi-runtime/pi-test.ps1", "utf8"));
    expect([...apiKeys].filter((key) => !bashKeys.has(key))).toEqual([]);
    expect([...apiKeys].filter((key) => !powershellKeys.has(key))).toEqual([]);
  });
});
