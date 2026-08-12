import { createHash } from "node:crypto";

import { after, NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, isAuthInputError } from "@/lib/auth/store";
import { dramaContentTool, dramaVisualTool } from "@/lib/server/drama-analysis";
import { toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { getLatestStoredGenerationTaskByRequest, withGenerationConcurrencyLimit } from "@/lib/server/generation-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { pointsResponseHeaders } from "@/lib/server/points-response";
import { checkRateLimit } from "@/lib/server/security";
import { systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { rankTextPlanningCandidates } from "@/lib/server/text-planning-runtime";
import { createTextTask, getTextTask, type TextTask, type TextTaskConfig } from "@/lib/server/text-task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AnalyzeBody = {
    phase?: "content" | "visual";
    projectId?: string;
    episodeId?: string;
    script?: string;
    summary?: string;
    style?: string;
    episode?: unknown;
    characters?: unknown;
    scenes?: unknown;
    props?: unknown;
    clues?: unknown;
    shots?: unknown;
};

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return apiError(401, "请先登录");
    if (!(await checkRateLimit(`drama-analyze:${user.id}`, { maxRequests: 10, windowMs: 60_000 })).allowed) return apiError(429, "剧本解析过于频繁，请稍后重试");

    let body: AnalyzeBody;
    try {
        body = await readJsonBody(request, 8 * 1024 * 1024);
    } catch (error) {
        if (isAuthInputError(error)) return apiError(error.status, error.message);
        throw error;
    }

    const phase = body.phase === "visual" ? "visual" : "content";
    const projectId = cleanText(body.projectId, 160);
    const episodeId = cleanText(body.episodeId, 160);
    if (!projectId || !episodeId) return apiError(400, "短剧项目参数不完整");
    const script = cleanText(body.script, 30_000);
    if (phase === "content" && !script) return apiError(400, "请先填写剧本");
    if (typeof body.script === "string" && body.script.trim().length > 30_000) return apiError(400, "单次解析剧本不能超过 30000 字");

    const visualInput = phase === "visual" ? normalizeVisualInput(body) : null;
    if (phase === "visual" && !visualInput?.shotIds.length) return apiError(400, "请先完成内容审核");

    const settings = await getAuthSettings();
    const logicalModel = settings.defaultModels.textModel;
    const resolvedCandidates = rankTextPlanningCandidates(resolveLogicalModelCandidates(settings, "text", logicalModel));
    if (!logicalModel || !resolvedCandidates.length) return apiError(400, "后台尚未配置可用的默认文本模型");

    const tool = phase === "visual" ? dramaVisualTool : dramaContentTool;
    const input = phase === "visual" ? visualInput!.payload : { script, summary: cleanText(body.summary, 2000), style: cleanText(body.style, 500) };
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const clientRequestId = systemAiIdempotencyKey("drama-analysis-task", user.id, projectId, episodeId, phase, inputHash);
    const existing = await latestDramaTask(user.id, clientRequestId);
    if (existing && isReusableDramaTask(existing)) return taskResponse(request, user, existing, inputHash, 202);

    const retryNo = existing ? (existing.retryNo ?? 0) + 1 : 0;
    const systemPrompt = dramaSystemPrompt(phase, tool.parameters);
    const configs = prioritizeRetryCandidates(resolvedCandidates, existing).map<TextTaskConfig>((candidate) => ({ ...toSystemGenerationChannel(candidate), systemPrompt, structuredOutput: tool }));
    const created = await withGenerationConcurrencyLimit(user.id, "text", 5 * 60_000, settings.generationConcurrency.text, () =>
        createTextTask({
            userId: user.id,
            config: configs[0],
            candidateConfigs: configs.slice(1),
            messages: [{ role: "user", content: JSON.stringify(input) }],
            surface: "drama",
            projectId,
            episodeId,
            clientRequestId,
            attemptNo: retryNo,
            retryNo,
            billingIdempotencyKey: systemAiIdempotencyKey("drama-analysis-billing", user.id, projectId, episodeId, phase, inputHash, String(retryNo)),
            metadata: {
                kind: "drama-analysis",
                phase,
                inputHash,
                defaultVideoSeconds: settings.generationDefaults.videoSeconds,
                ...(visualInput ? { shotIds: visualInput.shotIds } : {}),
            },
        }),
    );
    if (!created) {
        const duplicate = await latestDramaTask(user.id, clientRequestId);
        if (duplicate && isReusableDramaTask(duplicate)) return taskResponse(request, user, duplicate, inputHash, 202);
        return apiError(429, "当前文本分析任务已达到并发上限");
    }
    return taskResponse(request, user, (await getTextTask(created.id)) || created, inputHash, 202);
}

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return apiError(401, "请先登录");
    const taskId = cleanText(new URL(request.url).searchParams.get("taskId"), 160);
    if (!taskId) return apiError(400, "缺少分析任务 ID");
    const task = await getTextTask(taskId);
    if (!task || task.userId !== user.id || !isDramaTask(task)) return apiError(404, "分析任务不存在或已过期");
    wakeTask(request, task);
    return NextResponse.json({ code: 0, data: { task: publicTask(task), inputHash: cleanText(task.metadata?.inputHash, 64) }, msg: taskMessage(task) }, { headers: pointsResponseHeaders(user) });
}

async function taskResponse(request: Request, user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>, task: TextTask, inputHash: string, status: number) {
    if (task.status === "pending" || task.status === "running") {
        await scheduleGenerationTask("text", task.id, {
            ...(task.executionPhase ? {} : { executionPhase: "created" as const }),
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            nextPollAt: Date.now(),
            lastUpstreamStatus: task.executionPhase === "needs_review" ? "submission_outcome_unknown" : "client_wakeup",
        });
    }
    wakeTask(request, task);
    return NextResponse.json({ code: 0, data: { task: publicTask(task), inputHash }, msg: taskMessage(task) }, { status, headers: pointsResponseHeaders(user) });
}

function wakeTask(request: Request, task: TextTask) {
    if ((task.status !== "pending" && task.status !== "running") || task.executionPhase === "needs_review") return;
    const origin = resolveInternalOrigin(new URL(request.url).origin);
    after(() => runGenerationTaskRecoveryBatch({ origin, cookie: request.headers.get("cookie") || "", limit: 1, taskIds: [task.id] }));
}

async function latestDramaTask(userId: string, clientRequestId: string) {
    const stored = await getLatestStoredGenerationTaskByRequest<TextTask>("text", userId, clientRequestId);
    return stored ? getTextTask(stored.id) : null;
}

function publicTask(task: TextTask) {
    const phase = task.metadata?.phase === "visual" ? "visual" : "content";
    return {
        id: task.id,
        status: task.status,
        phase,
        result: task.status === "success" ? parseResult(task.result?.content) : undefined,
        error: task.error,
        needsReview: task.executionPhase === "needs_review",
        executionPhase: task.executionPhase,
        clientRequestId: task.clientRequestId,
    };
}

function parseResult(value?: string) {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}

function taskMessage(task: TextTask) {
    if (task.executionPhase === "needs_review") return "生成失败，请联系管理员";
    if (task.status === "error" || task.status === "cancelled") return task.error || "分析任务已结束";
    if (task.status === "success") return task.metadata?.phase === "visual" ? "视觉结构已生成" : "内容结构待审核";
    return task.metadata?.phase === "visual" ? "AI 正在生成视觉方案" : "AI 正在提取内容结构";
}

function isDramaTask(task: TextTask) {
    return task.surface === "drama" && task.metadata?.kind === "drama-analysis" && (task.metadata.phase === "content" || task.metadata.phase === "visual");
}

function isReusableDramaTask(task: TextTask) {
    return task.status === "success" || ((task.status === "pending" || task.status === "running") && task.executionPhase !== "needs_review");
}

function prioritizeRetryCandidates<T extends { channelId: string; upstreamModel: string }>(candidates: T[], existing: TextTask | null) {
    if (existing?.executionPhase !== "needs_review" || candidates.length < 2) return candidates;
    const uncertainIndex = candidates.findIndex((candidate) => candidate.channelId === existing.config.channelId && candidate.upstreamModel === existing.config.model);
    if (uncertainIndex < 0) return candidates;
    return [...candidates.slice(0, uncertainIndex), ...candidates.slice(uncertainIndex + 1), candidates[uncertainIndex]];
}

function dramaSystemPrompt(phase: "content" | "visual", parameters: Record<string, unknown>) {
    const schemaInstruction = `即使渠道没有传递工具定义，也必须只返回符合以下 JSON Schema 的对象，不能返回输入对象，不能把 script 或 summary 作为顶层字段：${JSON.stringify(parameters)}`;
    return phase === "visual"
        ? `你是影视视觉导演。输入内容已经由用户审核，必须严格保留每个 shotId、镜头数量、顺序、人物、场景、对白、旁白、原文和时长。为每个镜头补充图片提示词、视频提示词、起始/结束帧提示词、镜头运动和连续性数据；连续性必须明确景别、机位、构图、人物站位、视线、动作起止、屏幕运动方向和轴线规则。镜头之间要保持人物服装、道具、空间和视线关系连续。必须调用 design_drama_visuals。不要使用 Markdown。${schemaInstruction}`
        : `你是影视剧本编辑。只提取剧本明确存在的内容事实和镜头边界，不生成 imagePrompt、videoPrompt、镜头运动或画面风格，不添加无依据的主要情节。必须逐句保留所有角色直接说出的原话和原文明示的旁白，utterances 按原文顺序列出每一句，禁止把多句台词压缩成“某人说明/表示/询问”的剧情摘要；说话人转换、明确动作反应或场景变化都应成为可审核的镜头边界，sourceText 必须保留对应连续原文。必须调用 analyze_drama_content。不要使用 Markdown。${schemaInstruction}`;
}

function normalizeVisualInput(body: AnalyzeBody) {
    const shots = array(body.shots)
        .slice(0, 80)
        .flatMap((value) => {
            const shot = object(value);
            const id = cleanText(shot.id, 160);
            if (!id) return [];
            return [
                {
                    id,
                    title: cleanText(shot.title, 160),
                    description: cleanText(shot.description, 4000),
                    sourceText: cleanText(shot.sourceText, 8000),
                    shotBoundary: cleanText(shot.shotBoundary, 500),
                    dialogue: cleanText(shot.dialogue, 4000),
                    narration: cleanText(shot.narration, 4000),
                    utterances: array(shot.utterances).slice(0, 100),
                    duration: Math.max(1, Math.min(20, Number(shot.duration) || 5)),
                    characterIds: texts(shot.characterIds, 50),
                    sceneId: cleanText(shot.sceneId, 160),
                    propIds: texts(shot.propIds, 50),
                    clueIds: texts(shot.clueIds, 50),
                },
            ];
        });
    return {
        shotIds: shots.map((shot) => shot.id),
        payload: {
            project: { summary: cleanText(body.summary, 2000), style: cleanText(body.style, 500) },
            episode: normalizeVisualEpisode(body.episode),
            assets: {
                characters: normalizeVisualAssets(body.characters),
                scenes: normalizeVisualAssets(body.scenes),
                props: normalizeVisualAssets(body.props),
                clues: normalizeVisualAssets(body.clues),
            },
            shots,
        },
    };
}

function normalizeVisualEpisode(value: unknown) {
    const episode = object(value);
    return {
        id: cleanText(episode.id, 160),
        title: cleanText(episode.title, 160),
        outline: cleanText(episode.outline, 4000),
        hook: cleanText(episode.hook, 2000),
        nextPreview: cleanText(episode.nextPreview, 2000),
        sourceRange: cleanText(episode.sourceRange, 500),
    };
}

function normalizeVisualAssets(value: unknown) {
    return array(value)
        .slice(0, 200)
        .flatMap((item) => {
            const asset = object(item);
            const name = cleanText(asset.name, 120);
            if (!name) return [];
            const profile = object(asset.profile);
            return [
                {
                    id: cleanText(asset.id, 160),
                    name,
                    description: cleanText(asset.description, 2000),
                    profile: {
                        visualIdentity: cleanText(profile.visualIdentity, 2000),
                        styling: cleanText(profile.styling, 2000),
                        colorPalette: cleanText(profile.colorPalette, 500),
                        consistencyRules: cleanText(profile.consistencyRules, 2000),
                    },
                    payoff: cleanText(asset.payoff, 2000),
                },
            ];
        });
}

function apiError(status: number, msg: string) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}

function texts(value: unknown, limit: number) {
    return array(value)
        .map((item) => cleanText(item, 160))
        .filter(Boolean)
        .slice(0, limit);
}

function cleanText(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function object(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
