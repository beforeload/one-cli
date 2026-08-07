import path from "node:path";
import type { ToolRisk } from "./domain.js";

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; rule: string; message: string };

const SECRET_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
]);

export function evaluateHardPolicy(
  toolName: string,
  args: Record<string, unknown>,
  risk: ToolRisk,
): PolicyDecision {
  if (risk === "workspace_write") {
    const candidate = typeof args.path === "string" ? args.path : "";
    const normalized = candidate.split(path.sep).join("/");
    const basename = path.posix.basename(normalized).toLowerCase();
    if (
      SECRET_BASENAMES.has(basename) &&
      !basename.endsWith(".example") &&
      !basename.endsWith(".sample")
    ) {
      return deny("secret-file", `Refusing to modify sensitive file: ${basename}`);
    }
    if (normalized === ".git" || normalized.startsWith(".git/")) {
      return deny("git-internals", "Refusing to modify .git internals");
    }
  }

  if (toolName === "shell") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const lower = command.toLowerCase();
    const rules: Array<[RegExp, string, string]> = [
      [/(^|[;&|]\s*)(sudo|doas)\b/, "privilege-escalation", "Privilege escalation is not allowed"],
      [/\bgit\s+reset\s+--hard\b/, "destructive-git", "git reset --hard is not allowed"],
      [/\bgit\s+clean\s+-[a-z]*f[a-z]*d|\bgit\s+clean\s+-[a-z]*d[a-z]*f/, "destructive-git", "Forced git clean is not allowed"],
      [/\bgit\s+push\b[^\n]*(--force|-f)\b/, "history-rewrite", "Force-push is not allowed"],
      [/\bgit\s+rebase\s+(--interactive|-i)\b/, "interactive-history", "Interactive rebase is not supported"],
      [/\brm\s+-[a-z]*r[a-z]*f\b[^\n]*(\/($|\s)|~($|\/|\s))/, "root-removal", "Recursive removal of root/home is not allowed"],
      [/(^|\s)\/dev\/\S+/, "device-access", "Direct device access is not allowed"],
      [/\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh|python|node)\b/, "download-execute", "Download-and-execute pipelines are not allowed"],
      [/\b(OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|GH_TOKEN)\b/i, "credential-access", "Credential environment access is not allowed"],
    ];
    for (const [pattern, rule, message] of rules) {
      if (pattern.test(lower)) return deny(rule, message);
    }
  }

  return { allowed: true };
}

function deny(rule: string, message: string): PolicyDecision {
  return { allowed: false, rule, message };
}
