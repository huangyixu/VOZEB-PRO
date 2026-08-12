import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    after: vi.fn(),
    currentUser: vi.fn(),
    getAuthSettings: vi.fn(),
    checkRateLimit: vi.fn(),
    resolveCandidates: vi.fn(),
    toChannel: vi.fn(),
    latestByRequest: vi.fn(),
    withConcurrency: vi.fn(),
    createTextTask: vi.fn(),
    getTextTask: vi.fn(),
    schedule: vi.fn(),
    recover: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/auth/store", () => ({
    getAuthSettings: mocks.getAuthSettings,
    isAuthInputError: vi.fn(() => false),
}));
vi.mock("@/lib/server/security", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/server/generation-task-store", () => ({
    getLatestStoredGenerationTaskByRequest: mocks.latestByRequest,
    withGenerationConcurrencyLimit: mocks.withConcurrency,
}));
vi.mock("@/lib/server/text-task-store", () => ({
    createTextTask: mocks.createTextTask,
    getTextTask: mocks.getTextTask,
}));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://internal") }));
vi.mock("@/lib/server/points-response", () => ({ pointsResponseHeaders: vi.fn(() => new Headers({ "x-venlinks-pro-points-remaining": "2000" })) }));
vi.mock("@/lib/server/logical-model-router", () => ({ resolveLogicalModelCandidates: mocks.resolveCandidates }));
vi.mock("@/lib/server/text-planning-runtime", () => ({ rankTextPlanningCandidates: vi.fn((items) => items) }));
vi.mock("@/lib/server/generation-channel", () => ({ toSystemGenerationChannel: mocks.toChannel }));

import { GET, POST } from "./route";

describe("drama analysis task route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue(user());
        mocks.getAuthSettings.mockResolvedValue(settings());
        mocks.checkRateLimit.mockResolvedValue({ allowed: true });
        mocks.resolveCandidates.mockReturnValue([candidate("channel-one", "upstream-text"), candidate("channel-two", "backup-text")]);
        mocks.toChannel.mockImplementation((resolved: ReturnType<typeof candidate>) => ({
            apiSource: "system",
            baseUrl: `/api/ai/system/${resolved.channelId}`,
            apiKey: "system",
            apiFormat: "openai",
            model: resolved.upstreamModel,
            logicalModel: resolved.logicalModelId,
            channelId: resolved.channelId,
        }));
        mocks.latestByRequest.mockResolvedValue(null);
        mocks.withConcurrency.mockImplementation(async (_userId: string, _type: string, _staleMs: number, _limit: number, handler: () => Promise<unknown>) => handler());
        mocks.createTextTask.mockImplementation(async (input) => task({ ...input, id: "analysis-new", status: "pending" }));
        mocks.getTextTask.mockResolvedValue(null);
        mocks.after.mockImplementation(() => undefined);
    });

    it("creates a persistent structured task and returns before model execution", async () => {
        const response = await POST(contentRequest());
        const payload = await response.json();

        expect(response.status).toBe(202);
        expect(payload).toMatchObject({ code: 0, data: { task: { id: "analysis-new", status: "pending", phase: "content" } } });
        expect(payload.data.inputHash).toMatch(/^[a-f0-9]{64}$/);
        expect(mocks.createTextTask).toHaveBeenCalledWith(
            expect.objectContaining({
                surface: "drama",
                projectId: "drama-one",
                episodeId: "episode-one",
                retryNo: 0,
                attemptNo: 0,
                metadata: expect.objectContaining({ kind: "drama-analysis", phase: "content", defaultVideoSeconds: 5 }),
                config: expect.objectContaining({ structuredOutput: expect.objectContaining({ name: "analyze_drama_content" }) }),
            }),
        );
        expect(mocks.schedule).toHaveBeenCalledWith("text", "analysis-new", expect.objectContaining({ executionPhase: "created", nextPollAt: expect.any(Number) }));
        expect(mocks.recover).not.toHaveBeenCalled();
        expect(mocks.after).toHaveBeenCalledWith(expect.any(Function));
    });

    it("reuses an active task for the same stable input", async () => {
        const existing = task({ id: "analysis-existing", status: "running", executionPhase: "polling", clientRequestId: "stable-request" });
        mocks.latestByRequest.mockResolvedValue({ id: existing.id });
        mocks.getTextTask.mockResolvedValue(existing);

        const response = await POST(contentRequest());

        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ data: { task: { id: "analysis-existing", status: "running" } } });
        expect(mocks.withConcurrency).not.toHaveBeenCalled();
        expect(mocks.createTextTask).not.toHaveBeenCalled();
    });

    it("creates a new task attempt after an explicit retry of a failed input", async () => {
        const failed = task({ id: "analysis-failed", status: "error", retryNo: 2, error: "模型失败" });
        mocks.latestByRequest.mockResolvedValue({ id: failed.id });
        mocks.getTextTask.mockResolvedValueOnce(failed).mockResolvedValueOnce(null);

        const response = await POST(contentRequest());

        expect(response.status).toBe(202);
        expect(mocks.createTextTask).toHaveBeenCalledWith(expect.objectContaining({ retryNo: 3, attemptNo: 3 }));
        expect((await response.json()).data.task.id).toBe("analysis-new");
    });

    it("creates a new task after the user explicitly retries a needs-review submission", async () => {
        const needsReview = task({ id: "analysis-review", status: "running", executionPhase: "needs_review", retryNo: 1 });
        mocks.latestByRequest.mockResolvedValue({ id: needsReview.id });
        mocks.getTextTask.mockResolvedValueOnce(needsReview).mockResolvedValueOnce(null);

        const response = await POST(contentRequest());

        expect(response.status).toBe(202);
        expect(mocks.createTextTask).toHaveBeenCalledWith(
            expect.objectContaining({
                retryNo: 2,
                attemptNo: 2,
                config: expect.objectContaining({ channelId: "channel-two", model: "backup-text" }),
                candidateConfigs: [expect.objectContaining({ channelId: "channel-one", model: "upstream-text" })],
            }),
        );
        expect((await response.json()).data.task.id).toBe("analysis-new");
    });

    it("returns pending, needs-review, success and error task states without re-running a completed model", async () => {
        const pending = task({ id: "pending", status: "running", executionPhase: "polling" });
        mocks.getTextTask.mockResolvedValueOnce(pending);
        const pendingResponse = await GET(taskRequest("pending"));
        expect(await pendingResponse.json()).toMatchObject({ data: { task: { status: "running", needsReview: false } } });
        expect(mocks.after).toHaveBeenCalledTimes(1);

        mocks.after.mockClear();
        mocks.getTextTask.mockResolvedValueOnce(task({ id: "review", status: "running", executionPhase: "needs_review" }));
        const reviewResponse = await GET(taskRequest("review"));
        expect(await reviewResponse.json()).toMatchObject({ data: { task: { needsReview: true, executionPhase: "needs_review" } } });
        expect(mocks.after).not.toHaveBeenCalled();

        mocks.getTextTask.mockResolvedValueOnce(task({ id: "success", status: "success", executionPhase: "completed", result: { content: JSON.stringify({ shots: [{ title: "镜头" }] }) } }));
        const successResponse = await GET(taskRequest("success"));
        expect(await successResponse.json()).toMatchObject({ data: { task: { status: "success", result: { shots: [{ title: "镜头" }] } } } });

        mocks.getTextTask.mockResolvedValueOnce(task({ id: "error", status: "error", executionPhase: "completed", error: "没有可用模型" }));
        const errorResponse = await GET(taskRequest("error"));
        expect(await errorResponse.json()).toMatchObject({ data: { task: { status: "error", error: "没有可用模型" } } });
    });

    it("does not expose another user's or a generic text task", async () => {
        mocks.getTextTask.mockResolvedValueOnce(task({ id: "foreign", userId: "other-user" })).mockResolvedValueOnce(task({ id: "generic", surface: "chat", metadata: {} }));

        expect((await GET(taskRequest("foreign"))).status).toBe(404);
        expect((await GET(taskRequest("generic"))).status).toBe(404);
    });
});

function contentRequest() {
    return new Request("http://localhost/api/drama/analyze", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=test" },
        body: JSON.stringify({ phase: "content", projectId: "drama-one", episodeId: "episode-one", script: "主角推门进入。", summary: "简介", style: "电影感" }),
    });
}

function taskRequest(id: string) {
    return new Request(`http://localhost/api/drama/analyze?taskId=${id}`, { headers: { cookie: "session=test" } });
}

function task(patch: Record<string, unknown> = {}) {
    return {
        id: "analysis-one",
        userId: "user-one",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        config: { baseUrl: "/api/ai/system/channel-one", apiKey: "system", apiFormat: "openai", model: "upstream-text", logicalModel: "default-text", channelId: "channel-one" },
        candidateConfigs: [],
        messages: [{ role: "user", content: JSON.stringify({ script: "主角推门进入。" }) }],
        surface: "drama",
        projectId: "drama-one",
        episodeId: "episode-one",
        clientRequestId: "stable-request",
        retryNo: 0,
        metadata: { kind: "drama-analysis", phase: "content", inputHash: "a".repeat(64), defaultVideoSeconds: 5 },
        ...patch,
    };
}

function user() {
    return { id: "user-one", role: "user", pointsBalance: 2000 };
}

function settings() {
    return {
        defaultModels: { textModel: "default-text" },
        generationConcurrency: { text: 4 },
        generationDefaults: { videoSeconds: 5 },
        logicalModels: [],
        systemChannels: [],
    };
}

function candidate(channelId: string, upstreamModel: string) {
    return {
        logicalModelId: "default-text",
        upstreamModel,
        channelId,
        channel: { id: channelId, apiFormat: "openai", advancedConfig: { protocol: "openai" } },
    };
}
