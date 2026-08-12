import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api/points", () => ({ refreshUserPointsIfSystem: vi.fn(), syncUserPointsFromHeaders: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({
    resolveModelRequestConfig: vi.fn((config: Record<string, unknown>, model: string) => ({ ...config, model, apiSource: "system" })),
}));

import type { AiConfig } from "@/stores/use-config-store";
import { waitForTextGenerationTask } from "./text";

describe("文本任务轮询", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("shows the unified failure message for a legacy manual-review task", async () => {
        const fetchMock = vi.fn(async () => Response.json({ task: { id: "text-review", status: "running", model: "text-model", needsReview: true } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(waitForTextGenerationTask({ apiSource: "system" } as AiConfig, { id: "text-review", status: "running", model: "text-model" })).rejects.toThrow("生成失败，请联系管理员");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
