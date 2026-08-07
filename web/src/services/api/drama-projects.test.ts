import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ syncUserPointsFromHeaders: vi.fn() }));

vi.mock("@/services/api/points", () => ({ syncUserPointsFromHeaders: mocks.syncUserPointsFromHeaders }));

import { listDramaProjectSummaries, runDramaAnalysis } from "./drama-projects";

describe("drama project api", () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("requests a bounded summary page", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { projects: [], total: 24, page: 2, pageSize: 12 }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(listDramaProjectSummaries({ page: 2, pageSize: 12 })).resolves.toMatchObject({ total: 24, page: 2, pageSize: 12 });
        expect(fetchMock).toHaveBeenCalledWith("/api/drama/projects?page=2&pageSize=12", { cache: "no-store" });
    });

    it("creates and polls a content analysis task while syncing points", async () => {
        vi.useFakeTimers();
        const result = contentAnalysis();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(taskResponse({ id: "analysis-one", status: "pending", phase: "content" }, { "x-vozeb-pro-points-remaining": "1990" }))
            .mockResolvedValueOnce(taskResponse({ id: "analysis-one", status: "running", phase: "content" }))
            .mockResolvedValueOnce(taskResponse({ id: "analysis-one", status: "success", phase: "content", result }));
        vi.stubGlobal("fetch", fetchMock);

        const analysis = runDramaAnalysis({ phase: "content", projectId: "drama-one", episodeId: "episode-one", script: "原始剧本", summary: "简介", style: "国漫" });
        await vi.advanceTimersByTimeAsync(3000);

        await expect(analysis).resolves.toEqual(result);
        expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/drama/analyze", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal), body: expect.any(String) }));
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ projectId: "drama-one", episodeId: "episode-one", phase: "content", script: "原始剧本" });
        expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/drama/analyze?taskId=analysis-one", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
        expect(mocks.syncUserPointsFromHeaders).toHaveBeenCalledTimes(3);
        expect(mocks.syncUserPointsFromHeaders).toHaveBeenNthCalledWith(1, expect.any(Headers), "system");
    });

    it("returns an already completed task without polling again", async () => {
        const result = contentAnalysis();
        const fetchMock = vi.fn().mockResolvedValue(taskResponse({ id: "analysis-complete", status: "success", phase: "content", result }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runDramaAnalysis({ phase: "content", projectId: "drama-one", episodeId: "episode-one", script: "原始剧本", summary: "", style: "" })).resolves.toEqual(result);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("maps an HTML 504 response to an actionable analysis error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html><title>504 Gateway Time-out</title><body>nginx</body>", { status: 504, headers: { "content-type": "text/html" } })));

        await expect(runDramaAnalysis({ phase: "content", projectId: "drama-one", episodeId: "episode-one", script: "剧本", summary: "", style: "" })).rejects.toThrow("AI 分析服务响应超时（HTTP 504），请稍后再次点击继续查询");
        expect(mocks.syncUserPointsFromHeaders).toHaveBeenCalledWith(expect.any(Headers), "system");
    });

    it("stops polling on terminal errors and needs-review tasks", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(taskResponse({ id: "failed", status: "error", phase: "content", error: "模型返回失败" }))
            .mockResolvedValueOnce(taskResponse({ id: "review", status: "pending", phase: "visual", needsReview: true }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runDramaAnalysis({ phase: "content", projectId: "drama-one", episodeId: "episode-one", script: "剧本", summary: "", style: "" })).rejects.toThrow("模型返回失败");
        await expect(runDramaAnalysis({ phase: "visual", projectId: "drama-one", episodeId: "episode-one", summary: "", style: "", episode: episode(), characters: [], scenes: [], props: [], clues: [], shots: [] })).rejects.toMatchObject({
            name: "GenerationTaskNeedsReviewError",
            message: expect.stringContaining("请再次点击重试"),
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("aborts client polling without cancelling the persistent task", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const fetchMock = vi.fn().mockResolvedValue(taskResponse({ id: "analysis-one", status: "pending", phase: "content" }));
        vi.stubGlobal("fetch", fetchMock);

        const analysis = runDramaAnalysis({ phase: "content", projectId: "drama-one", episodeId: "episode-one", script: "剧本", summary: "", style: "" }, { signal: controller.signal });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();

        await expect(analysis).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("enforces a total polling timeout while leaving the server task running", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(taskResponse({ id: "analysis-one", status: "running", phase: "content" })));
        vi.stubGlobal("fetch", fetchMock);

        const analysis = runDramaAnalysis({ phase: "content", projectId: "drama-one", episodeId: "episode-one", script: "剧本", summary: "", style: "" }, { timeoutMs: 2000 });
        const rejection = expect(analysis).rejects.toThrow("AI 分析等待超时，任务仍在后台，可再次点击继续查询");
        await vi.advanceTimersByTimeAsync(2001);

        await rejection;
        expect(fetchMock.mock.calls.every(([, init]) => !init || init.method !== "PATCH")).toBe(true);
    });
});

function taskResponse(task: Record<string, unknown>, headers?: HeadersInit) {
    return Response.json({ code: 0, data: { task }, msg: "OK" }, { headers });
}

function contentAnalysis() {
    return {
        episode: { outline: "大纲", hook: "钩子", nextPreview: "预告", sourceRange: "第一场" },
        characters: [],
        scenes: [],
        props: [],
        clues: [],
        shots: [
            {
                title: "镜头一",
                description: "人物入场",
                sourceText: "人物入场",
                shotBoundary: "动作结束",
                dialogue: "",
                narration: "",
                utterances: [],
                duration: 5,
                characterNames: [],
                sceneName: "",
                propNames: [],
                clueNames: [],
            },
        ],
    };
}

function episode() {
    return { id: "episode-one", title: "第一集", script: "剧本", outline: "", hook: "", nextPreview: "", sourceRange: "", reviewStatus: "content_review" as const, shots: [] };
}
