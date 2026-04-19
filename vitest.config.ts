import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    exclude: ["**/node_modules/**", "**/.claude/worktrees/**", "**/dist/**"],
  },
});
