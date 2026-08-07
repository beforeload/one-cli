import { createInterface } from "node:readline/promises";
import type {
  ApprovalMode,
  ApprovalPort,
  ApprovalRequest,
  ToolRisk,
} from "./domain.js";
import { isAbortError } from "./domain.js";

export type ApprovalRequirement = "allow" | "prompt" | "deny";

export function approvalRequirement(
  mode: ApprovalMode,
  risk: ToolRisk,
): ApprovalRequirement {
  if (risk === "read") return "allow";
  if (mode === "deny") return "deny";
  if (mode === "all") return "allow";
  if (mode === "auto-edit" && risk === "workspace_write") return "allow";
  return "prompt";
}

export class TtyApprovalPort implements ApprovalPort {
  async request(request: ApprovalRequest, signal: AbortSignal) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) return "denied" as const;
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await readline.question(
        `\nTool approval required\n${neutralize(request.summary)}\nApprove once? [y/N] `,
        { signal },
      );
      return answer.trim().toLowerCase() === "y" ? ("approved" as const) : ("denied" as const);
    } catch (error) {
      if (isAbortError(error)) return "cancelled" as const;
      throw error;
    } finally {
      readline.close();
    }
  }
}

export class DenyApprovalPort implements ApprovalPort {
  async request(_request: ApprovalRequest, signal: AbortSignal) {
    return signal.aborted ? ("cancelled" as const) : ("denied" as const);
  }
}

export function neutralize(value: string, maxLength = 8_192): string {
  const visible = value
    .replace(/\u001b/g, "␛")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "�")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "�")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u007f]/g, "�");
  return visible.length > maxLength ? `${visible.slice(0, maxLength)}\n…[truncated]` : visible;
}
