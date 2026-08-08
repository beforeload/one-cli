import { describe, expect, it } from "vitest";
import {
  deterministicReview,
  independentReview,
  type ReviewerPort,
} from "../../src/autonomy/review.js";

describe("autonomy review policy", () => {
  it("blocks governance and secret-like changes deterministically", () => {
    const review = deterministicReview(
      "+const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';\n",
      ["src/value.ts", ".autonomy/product.yml"],
    );
    expect(review.blocked).toBe(true);
    expect(review.approvalRequired).toBe(true);
    expect(review.findings.map((finding) => finding.code)).toContain("governance-change");
    expect(review.findings.some((finding) => finding.code.startsWith("secret-"))).toBe(true);
  });

  it("requires valid structured independent review output", async () => {
    const valid: ReviewerPort = {
      review: async () => ({
        valid: true,
        criticalFindings: [],
        warnings: ["consider an edge case"],
        summary: "bounded",
      }),
    };
    await expect(
      independentReview(valid, { issue: "x", patch: "+x", changedPaths: ["src/x.ts"] }),
    ).resolves.toMatchObject({ valid: true, criticalFindings: [] });

    const invalid: ReviewerPort = { review: async () => "looks good" };
    await expect(
      independentReview(invalid, { issue: "x", patch: "+x", changedPaths: ["src/x.ts"] }),
    ).rejects.toThrow("invalid response");
  });
});
