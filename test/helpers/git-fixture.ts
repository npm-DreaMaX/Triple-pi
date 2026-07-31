import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface GitFixture {
  cwd: string;
  git(args: string[]): string;
  write(relativePath: string, content: string): Promise<void>;
  remove(relativePath: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createGitFixture(
  options: { initializeGit?: boolean } = {},
): Promise<GitFixture> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-git-"));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Reviewer Test",
    GIT_AUTHOR_EMAIL: "reviewer-test@example.com",
    GIT_COMMITTER_NAME: "Reviewer Test",
    GIT_COMMITTER_EMAIL: "reviewer-test@example.com",
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
  const write = async (relativePath: string, content: string) => {
    const target = path.join(cwd, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };

  if (options.initializeGit !== false) git(["init", "--quiet"]);

  return {
    cwd,
    git,
    write,
    remove: (relativePath) => fs.rm(path.join(cwd, relativePath), { force: true }),
    cleanup: () => fs.rm(cwd, { recursive: true, force: true }),
  };
}
