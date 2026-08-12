import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DramaShot } from "@/lib/drama-project-contract";

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
            .mockResolvedValueOnce(taskResponse({ id: "analysis-one", status: "pending", phase: "content" }, { "x-venlinks-pro-points-remaining": "1990" }))
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

    it("splits long visual plans into bounded persistent tasks and merges target shots in order", async () => {
        const shots = Array.from({ length: 17 }, (_, index) => dramaShot(index + 1));
        const requestedBatches: string[][] = [];
        const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
            const input = JSON.parse(String(init?.body)) as { shots: DramaShot[] };
            requestedBatches.push(input.shots.map((shot) => shot.id));
            return Promise.resolve(
                taskResponse({
                    id: `visual-${requestedBatches.length}`,
                    status: "success",
                    phase: "visual",
                    result: { shots: input.shots.map((shot) => visualShot(shot.id)) },
                }),
            );
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await runDramaAnalysis({ phase: "visual", projectId: "drama-one", episodeId: "episode-one", summary: "", style: "", episode: episode(), characters: [], scenes: [], props: [], clues: [], shots });

        expect(requestedBatches).toEqual([shots.slice(0, 9).map((shot) => shot.id), shots.slice(7, 17).map((shot) => shot.id), shots.slice(15, 17).map((shot) => shot.id)]);
        expect(result.shots.map((shot) => shot.shotId)).toEqual(shots.map((shot) => shot.id));
        expect(fetchMock).toHaveBeenCalledTimes(3);
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

function dramaShot(order: number): DramaShot {
    return {
        id: `shot-${order}`,
        order,
        title: `镜头 ${order}`,
        description: "人物继续行动",
        sourceText: "人物继续行动。",
        shotBoundary: "动作结束",
        dialogue: "",
        narration: "",
        utterances: [],
        imagePrompt: "",
        videoPrompt: "",
        cameraMotion: "",
        duration: 5,
        characterIds: [],
        propIds: [],
        clueIds: [],
    };
}

function visualShot(shotId: string) {
    return {
        shotId,
        imagePrompt: `${shotId} 图片提示词`,
        videoPrompt: `${shotId} 视频提示词`,
        cameraMotion: "固定镜头",
        startFramePrompt: "动作开始",
        endFramePrompt: "动作结束",
        negativePrompt: "画面瑕疵",
        continuity: {
            shotSize: "中景",
            cameraAngle: "平视",
            composition: "居中",
            characterBlocking: "画面中央",
            gazeDirection: "看向右侧",
            actionStart: "站立",
            actionEnd: "转身",
            screenDirection: "从左向右",
            axisRule: "保持轴线",
            continuityNotes: "延续上一镜头",
        },
    };
}
