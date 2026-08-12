import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getTask: vi.fn(),
    updateTask: vi.fn(),
    transitionTask: vi.fn(),
    refund: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refund }));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
vi.mock("@/lib/server/text-task-store", () => ({
    getTextTask: mocks.getTask,
    updateTextTask: mocks.updateTask,
    transitionTextTask: mocks.transitionTask,
}));

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { dramaContentTool } from "@/lib/server/drama-analysis";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { maintenanceWorkerContext } from "./maintenance-auth";
import { runTextTaskStep, taskHeaders } from "./text-task-runtime";
import type { TextTask, TextTaskConfig } from "./text-task-store";

describe("text task runtime recovery", () => {
    let state: TextTask;

    beforeEach(() => {
        vi.clearAllMocks();
        state = textTask(customConfig("channel-one", "https://one.example"));
        mocks.getTask.mockImplementation(async () => state);
        mocks.updateTask.mockImplementation(async (_id: string, patch: Partial<TextTask>) => {
            state = { ...state, ...patch };
            return state;
        });
        mocks.transitionTask.mockImplementation(async (_task: TextTask, allowed: string[], patch: Partial<TextTask>) => {
            if (!allowed.includes(state.status)) return null;
            state = { ...state, ...patch };
            return state;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it("preserves maintenance authorization for the internal system proxy", () => {
        const token = "m".repeat(32);
        vi.stubEnv("VENLINKS_MAINTENANCE_TOKEN", token);

        const headers = taskHeaders({ ...openAiConfig("channel-one", "/api/ai/system/channel-one"), apiKey: "system" }, maintenanceWorkerContext("user-one"), "text-task:test:attempt:1");

        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
        expect(headers.get("x-venlinks-worker-user-id")).toBe("user-one");
        expect(headers.get("x-venlinks-logical-model")).toBe("text-model");
        expect(headers.get("x-venlinks-points-idempotency-key")).toBe("text-task:test:attempt:1");
    });

    it("completes through a live OpenAI-compatible fixture", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        state = textTask(openAiConfig("fixture-text", `${origin}/v1`));

        try {
            await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
            expect(state).toMatchObject({ status: "success", result: { content: "协议测试文本返回成功" } });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/v1/chat/completions" });
            expect(fixture.requests[0]?.headers.authorization).toBe("Bearer key");
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("sends and reads structured tools across Chat, Responses, Gemini and Claude protocols", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const configs = [
            structuredConfig(openAiConfig("chat", `${origin}/v1`)),
            structuredConfig(responsesConfig("responses", `${origin}/v1`)),
            structuredConfig({ ...openAiConfig("gemini", `${origin}/v1`), apiFormat: "gemini" }),
            structuredConfig({
                ...openAiConfig("claude", `${origin}/v1`),
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "auto", createPath: "/messages" },
            }),
        ];

        try {
            for (const config of configs) {
                state = dramaTextTask(config);
                await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
                expect(JSON.parse(state.result?.content || "{}").shots).toHaveLength(1);
            }
            expect(fixture.requests.map((request) => request.path)).toEqual(["/v1/chat/completions", "/v1/responses", "/v1/models/text-model:generateContent", "/v1/messages"]);
            const bodies = fixture.requests.map((request) => JSON.parse(request.body));
            expect(bodies[0].tools[0].function).toMatchObject({ name: "analyze_drama_content", parameters: expect.any(Object) });
            expect(bodies[1].tools[0]).toMatchObject({ type: "function", name: "analyze_drama_content", parameters: expect.any(Object) });
            expect(bodies[0].tools[0].function.strict).toBeUndefined();
            expect(bodies[1].tools[0].strict).toBeUndefined();
            expect(bodies[2].tools[0].functionDeclarations[0]).toMatchObject({ name: "analyze_drama_content", parameters: expect.any(Object) });
            expect(bodies[3].tools[0]).toMatchObject({ name: "analyze_drama_content", input_schema: expect.any(Object) });
            expect(fixture.requests.every((request) => request.headers["idempotency-key"]?.startsWith("text-task:"))).toBe(true);
            expect(fixture.requests.every((request) => request.headers["x-client-request-id"] === request.headers["idempotency-key"])).toBe(true);
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("persists an asynchronous task ID and queries only one step per worker run", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ task_id: "upstream-one", status: "queued" }))
            .mockResolvedValueOnce(Response.json({ status: "processing" }))
            .mockResolvedValueOnce(Response.json({ status: "completed", data: { output: "最终结果" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "pending", upstreamTaskId: "upstream-one" });
        expect(state.upstream).toEqual({ id: "upstream-one", createPath: "/jobs" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "pending", status: "processing" });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(state.status).toBe("success");
        expect(state.result?.content).toBe("最终结果");
    });

    it("does not create through another channel after a network-uncertain submission", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error("socket closed"));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "needs_review" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(state.config.channelId).toBe("channel-one");
        expect(state.candidateConfigs).toHaveLength(1);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["running"]);
    });

    it("does not create through another channel after a submission timeout", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        const fetchMock = vi.fn().mockRejectedValueOnce(Object.assign(new Error("request timed out"), { name: "TimeoutError" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "needs_review", error: expect.stringContaining("上游是否已受理待确认") });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://one.example/v1/chat/completions");
        expect(state.config.channelId).toBe("channel-one");
        expect(state.candidateConfigs).toHaveLength(1);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["running"]);
    });

    it("refunds an invalid drama structure before switching to the backup model", async () => {
        state = dramaTextTask(structuredConfig(openAiConfig("channel-one", "https://one.example")), [structuredConfig(openAiConfig("channel-two", "https://two.example"))]);
        const invalid = { episode: { outline: "空结果" }, characters: [], scenes: [], props: [], clues: [], shots: [] };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(toolResponse(invalid, { "x-venlinks-points-cost": "0", "x-venlinks-points-record-id": "invalid-record" }))
            .mockResolvedValueOnce(toolResponse(validDramaContent()));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mocks.refund).toHaveBeenCalledWith("user-one", "text-model", 0, "text", 1, expect.stringMatching(/^text-task-refund:/), "invalid-record");
        expect(state.config.channelId).toBe("channel-two");
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
    });

    it("refunds a truncated structured response before switching candidates", async () => {
        state = dramaTextTask(structuredConfig(responsesConfig("channel-one", "https://one.example")), [structuredConfig(openAiConfig("channel-two", "https://two.example"))]);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, { headers: { "x-venlinks-points-cost": "1", "x-venlinks-points-record-id": "truncated-record" } }))
            .mockResolvedValueOnce(toolResponse(validDramaContent()));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });

        expect(mocks.refund).toHaveBeenCalledWith("user-one", "text-model", 1, "text", 1, expect.stringMatching(/^text-task-refund:/), "truncated-record");
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
    });

    it.each(["length", "max_tokens", "MAX_TOKENS"])("rejects and refunds a Chat-compatible truncated response with finish reason %s", async (finishReason) => {
        state = dramaTextTask(structuredConfig(openAiConfig("channel-one", "https://one.example")), [structuredConfig(openAiConfig("channel-two", "https://two.example"))]);
        const recordId = `truncated-${finishReason}`;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(toolResponse(validDramaContent(), { "x-venlinks-points-cost": "1", "x-venlinks-points-record-id": recordId }, finishReason))
            .mockResolvedValueOnce(toolResponse(validDramaContent()));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mocks.refund).toHaveBeenCalledWith("user-one", "text-model", 1, "text", 1, expect.stringMatching(/^text-task-refund:/), recordId);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
    });

    it("switches channels after a deterministic 422 rejection", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [{ ...openAiConfig("channel-two", "https://two.example"), apiFormat: "gemini" }]);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: { message: "参数不受支持" } }, { status: 422 }))
            .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "备用渠道结果" }] } }] }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(state.config.channelId).toBe("channel-two");
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
        expect(state.result?.content).toBe("备用渠道结果");
    });

    it("switches models instead of trying another protocol on the same model", async () => {
        state = textTask(responsesConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: { message: "/backend-api/conversation failed: status=422, body=" } }, { status: 422 }))
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Chat 兼容返回" } }] }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://one.example/v1/responses");
        expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://two.example/v1/chat/completions");
        expect(state.config.channelId).toBe("channel-two");
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
        expect(state.result?.content).toBe("Chat 兼容返回");
    });

    it("marks a 2xx invalid JSON response for manual review", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })));

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "needs_review" });
        expect(state.config.channelId).toBe("channel-one");
    });

    it("refunds a zero-point recorded charge when the upstream task fails", async () => {
        const headers = { "x-venlinks-points-cost": "0", "x-venlinks-points-record-id": "record-zero" };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ task_id: "upstream-zero", status: "queued" }, { headers }))
            .mockResolvedValueOnce(Response.json({ status: "failed", error: { message: "upstream failed" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "pending" });
        expect(state.billing).toMatchObject({ pointsCost: 0, pointsRecordId: "record-zero", refunded: false });
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "failed" });

        expect(mocks.refund).toHaveBeenCalledWith("user-one", "text-model", 0, "text", 1, expect.stringMatching(/^text-task-refund:/), "record-zero");
    });
});

function textTask(config: TextTaskConfig, candidateConfigs: TextTaskConfig[] = []): TextTask {
    return {
        id: "text-one",
        userId: "user-one",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        config,
        candidateConfigs,
        messages: [{ role: "user", content: "test" }],
    };
}

function dramaTextTask(config: TextTaskConfig, candidateConfigs: TextTaskConfig[] = []): TextTask {
    return {
        ...textTask(config, candidateConfigs),
        messages: [{ role: "user", content: JSON.stringify({ script: "主角推门说：测试开始。" }) }],
        retryNo: 0,
        billingIdempotencyKey: "drama-billing-one",
        metadata: { kind: "drama-analysis", phase: "content", defaultVideoSeconds: 5 },
    };
}

function structuredConfig(config: TextTaskConfig): TextTaskConfig {
    return { ...config, structuredOutput: dramaContentTool };
}

function toolResponse(value: unknown, headers?: HeadersInit, finishReason = "stop") {
    return Response.json(
        {
            choices: [
                {
                    finish_reason: finishReason,
                    message: { content: "", tool_calls: [{ type: "function", function: { name: "analyze_drama_content", arguments: JSON.stringify(value) } }] },
                },
            ],
        },
        { headers },
    );
}

function validDramaContent() {
    return {
        episode: { outline: "测试大纲", hook: "门打开", nextPreview: "下一幕", sourceRange: "全文" },
        characters: [{ name: "主角", description: "测试角色" }],
        scenes: [{ name: "测试房间", description: "明亮房间" }],
        props: [],
        clues: [],
        shots: [
            {
                title: "进入房间",
                description: "主角推门进入。",
                sourceText: "主角推门说：测试开始。",
                shotBoundary: "动作结束",
                dialogue: "测试开始。",
                narration: "",
                utterances: [{ type: "dialogue", speaker: "主角", text: "测试开始。" }],
                duration: 5,
                characterNames: ["主角"],
                sceneName: "测试房间",
                propNames: [],
                clueNames: [],
            },
        ],
    };
}

function customConfig(channelId: string, baseUrl: string): TextTaskConfig {
    return {
        baseUrl,
        apiKey: "key",
        apiFormat: "openai",
        model: "text-model",
        channelId,
        advancedConfig: {
            ...emptyAdvancedConfig(),
            protocol: "custom",
            createPath: "/jobs",
            queryPath: "/jobs/{taskId}",
            requestTemplate: '{"prompt":"{{prompt}}"}',
            resultField: "data.output",
            statusField: "status",
        },
    };
}

function openAiConfig(channelId: string, baseUrl: string): TextTaskConfig {
    return { baseUrl, apiKey: "key", apiFormat: "openai", model: "text-model", channelId };
}

function responsesConfig(channelId: string, baseUrl: string): TextTaskConfig {
    return {
        ...openAiConfig(channelId, baseUrl),
        advancedConfig: {
            ...emptyAdvancedConfig(),
            protocol: "compatible",
            createPath: "/responses",
        },
    };
}
