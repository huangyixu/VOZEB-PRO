import type { CreateDramaProjectInput, DramaContentAnalysis, DramaCostSummary, DramaEpisode, DramaProject, DramaProjectSummary, DramaProjectVersion, DramaShot, DramaVisualAnalysis, DramaVisualReview } from "@/lib/drama-project-contract";
import { GenerationTaskNeedsReviewError, type GenerationTaskExecutionState } from "@/services/api/generation-task-state";
import { syncUserPointsFromHeaders } from "@/services/api/points";

export type DramaProjectSummaryResponse = { projects: DramaProjectSummary[]; total: number; page: number; pageSize: number };
export type DramaContentAnalysisRequest = {
    phase: "content";
    projectId: string;
    episodeId: string;
    script: string;
    summary: string;
    style: string;
};
export type DramaVisualAnalysisRequest = {
    phase: "visual";
    projectId: string;
    episodeId: string;
    summary: string;
    style: string;
    episode: DramaEpisode;
    characters: DramaProject["characters"];
    scenes: DramaProject["scenes"];
    props: DramaProject["props"];
    clues: DramaProject["clues"];
    shots: DramaShot[];
};
type DramaAnalysisRequest = DramaContentAnalysisRequest | DramaVisualAnalysisRequest;
type DramaAnalysisResult = DramaContentAnalysis | DramaVisualAnalysis;
type DramaAnalysisTask = GenerationTaskExecutionState & {
    id: string;
    status: "pending" | "running" | "success" | "error" | "cancelled";
    phase: DramaAnalysisRequest["phase"];
    result?: DramaAnalysisResult;
    error?: string;
};
type DramaAnalysisTaskResponse = { task: DramaAnalysisTask | null; inputHash?: string };
type DramaRequestOptions = { signal?: AbortSignal; timeoutMs?: number };

const DRAMA_ANALYSIS_POLL_INTERVAL_MS = 1500;
const DRAMA_ANALYSIS_TIMEOUT_MS = 10 * 60_000;
const DRAMA_ANALYSIS_TIMEOUT_MESSAGE = "AI 分析等待超时，任务仍在后台，可再次点击继续查询";
const DRAMA_VISUAL_BATCH_SIZE = 8;
const DRAMA_VISUAL_CONTEXT_SIZE = 1;

export function runDramaAnalysis(input: DramaContentAnalysisRequest, options?: DramaRequestOptions): Promise<DramaContentAnalysis>;
export function runDramaAnalysis(input: DramaVisualAnalysisRequest, options?: DramaRequestOptions): Promise<DramaVisualAnalysis>;
export async function runDramaAnalysis(input: DramaAnalysisRequest, options?: DramaRequestOptions): Promise<DramaAnalysisResult> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException(DRAMA_ANALYSIS_TIMEOUT_MESSAGE, "TimeoutError"));
    }, options?.timeoutMs || DRAMA_ANALYSIS_TIMEOUT_MS);
    try {
        if (input.phase === "visual" && input.shots.length > DRAMA_VISUAL_BATCH_SIZE) return await runVisualAnalysisBatches(input, controller.signal);
        return await runSingleDramaAnalysis(input, controller.signal);
    } catch (error) {
        if (timedOut) throw new Error(DRAMA_ANALYSIS_TIMEOUT_MESSAGE);
        throw error;
    } finally {
        globalThis.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

async function runVisualAnalysisBatches(input: DramaVisualAnalysisRequest, signal: AbortSignal): Promise<DramaVisualAnalysis> {
    const visualByShot = new Map<string, DramaVisualAnalysis["shots"][number]>();
    for (let start = 0; start < input.shots.length; start += DRAMA_VISUAL_BATCH_SIZE) {
        const target = input.shots.slice(start, start + DRAMA_VISUAL_BATCH_SIZE);
        const context = input.shots.slice(Math.max(0, start - DRAMA_VISUAL_CONTEXT_SIZE), Math.min(input.shots.length, start + DRAMA_VISUAL_BATCH_SIZE + DRAMA_VISUAL_CONTEXT_SIZE));
        const result = (await runSingleDramaAnalysis({ ...input, shots: context }, signal)) as DramaVisualAnalysis;
        const targetIds = new Set(target.map((shot) => shot.id));
        result.shots.forEach((shot) => {
            if (targetIds.has(shot.shotId)) visualByShot.set(shot.shotId, shot);
        });
    }
    const shots = input.shots.flatMap((shot) => {
        const visual = visualByShot.get(shot.id);
        return visual ? [visual] : [];
    });
    if (shots.length !== input.shots.length) throw new Error("AI 视觉方案分批结果不完整，请再次点击继续生成");
    return { shots };
}

async function runSingleDramaAnalysis(input: DramaAnalysisRequest, signal: AbortSignal): Promise<DramaAnalysisResult> {
    let task = (await dramaAnalysisRequest("/api/drama/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal })).task;
    if (!task) throw new Error("AI 分析任务创建失败");
    for (;;) {
        const result = completedDramaAnalysis(task, input.phase);
        if (result) return result;
        await delay(DRAMA_ANALYSIS_POLL_INTERVAL_MS, signal);
        task = (await dramaAnalysisRequest(`/api/drama/analyze?taskId=${encodeURIComponent(task.id)}`, { cache: "no-store", signal })).task;
        if (!task) throw new Error("AI 分析任务不存在或已过期");
    }
}

export function listDramaProjectSummaries(input: { page?: number; pageSize?: number } = {}) {
    const query = new URLSearchParams({ page: String(input.page || 1), pageSize: String(input.pageSize || 12) });
    return request<DramaProjectSummaryResponse>(`/api/drama/projects?${query}`);
}

export async function getDramaProject(id: string) {
    return request<{ project: DramaProject }>(`/api/drama/projects/${encodeURIComponent(id)}`).then((data) => data.project);
}

export function createDramaProject(input: CreateDramaProjectInput) {
    return request<{ project: DramaProject }>("/api/drama/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then((data) => data.project);
}

export function saveDramaProject(project: DramaProject) {
    return request<{ project: DramaProject }>(`/api/drama/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project) }).then((data) => data.project);
}

export function deleteDramaProject(id: string) {
    return request<{ deleted: boolean }>(`/api/drama/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function createDramaProjectVersion(project: DramaProject, reason: string) {
    return request<{ version: DramaProjectVersion }>(`/api/drama/projects/${encodeURIComponent(project.id)}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, snapshot: project }),
    }).then((data) => data.version);
}

export function listDramaProjectVersions(projectId: string) {
    return request<{ versions: DramaProjectVersion[] }>(`/api/drama/projects/${encodeURIComponent(projectId)}/versions`).then((data) => data.versions);
}

export function restoreDramaProjectVersion(projectId: string, versionId: string) {
    return request<{ project: DramaProject }>(`/api/drama/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`, { method: "POST" }).then((data) => data.project);
}

export function getDramaProjectCosts(projectId: string) {
    return request<{ summary: DramaCostSummary }>(`/api/drama/projects/${encodeURIComponent(projectId)}/costs`).then((data) => data.summary);
}

export function reviewDramaEpisode(project: DramaProject, episode: DramaEpisode) {
    return request<{ review: DramaVisualReview }>("/api/drama/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: { title: project.title, summary: project.summary, style: project.style, ratio: project.ratio }, episode }),
    }).then((data) => data.review);
}

export async function exportDramaJianyingDraft(projectId: string, input: { episodeId: string; draftPath: string; version: "5" | "6" }) {
    const response = await fetch(`/api/drama/projects/${encodeURIComponent(projectId)}/export-jianying`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { msg?: string };
        throw new Error(payload.msg || "剪映草稿导出失败");
    }
    const disposition = response.headers.get("content-disposition") || "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return { blob: await response.blob(), fileName: encodedName ? decodeURIComponent(encodedName) : "短剧剪映草稿.zip" };
}

function completedDramaAnalysis(task: DramaAnalysisTask, phase: DramaAnalysisRequest["phase"]): DramaAnalysisResult | undefined {
    if (task.phase !== phase) throw new Error("AI 分析任务阶段不匹配，请重新提交");
    if (task.needsReview || task.executionPhase === "needs_review") throw new GenerationTaskNeedsReviewError("上游创建状态待确认，系统已停止自动重复创建；请再次点击重试，若问题持续请联系管理员");
    if (task.status === "error" || task.status === "cancelled") throw new Error(task.error || (task.status === "cancelled" ? "AI 分析任务已取消" : "AI 分析失败"));
    if (task.status !== "success") return undefined;
    if (!task.result) throw new Error("AI 分析任务没有返回结果");
    return task.result;
}

async function dramaAnalysisRequest(url: string, init: RequestInit): Promise<DramaAnalysisTaskResponse> {
    const response = await fetch(url, init);
    syncUserPointsFromHeaders(response.headers, "system");
    const text = await response.text();
    const payload = parseDramaResponse<DramaAnalysisTaskResponse>(text);
    if (!response.ok || (typeof payload?.code === "number" && payload.code !== 0)) throw new Error(dramaAnalysisError(response, payload, text));
    if (!payload?.data) throw new Error(payload?.msg || "AI 分析任务响应无效");
    return payload.data;
}

function parseDramaResponse<T>(text: string) {
    if (!text.trim()) return null;
    try {
        return JSON.parse(text) as { code?: number; data?: T; msg?: string; error?: string | { message?: string } };
    } catch {
        return null;
    }
}

function dramaAnalysisError(response: Response, payload: ReturnType<typeof parseDramaResponse<DramaAnalysisTaskResponse>>, text: string) {
    const nested = payload?.error && typeof payload.error === "object" ? payload.error.message : undefined;
    const message = payload?.msg || (typeof payload?.error === "string" ? payload.error : nested);
    if (message) return message;
    if (response.status === 504) return "AI 分析服务响应超时（HTTP 504），请稍后再次点击继续查询";
    if (response.status === 502 || response.status === 503) return "AI 分析服务暂不可用，请稍后重试";
    if (/<!doctype\s+html|<html\b|<title>|<body\b|\bnginx\b|\bcloudflare\b/i.test(text)) return `AI 分析服务请求失败（HTTP ${response.status || 500}）`;
    return response.status ? `AI 分析请求失败（HTTP ${response.status}）` : "AI 分析请求失败";
}

function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason || new DOMException("请求已取消", "AbortError"));
        const timer = globalThis.setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        const abort = () => {
            globalThis.clearTimeout(timer);
            reject(signal.reason || new DOMException("请求已取消", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
    });
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => ({}))) as { data?: T; msg?: string };
    if (!response.ok || !payload.data) throw new Error(payload.msg || "短剧项目请求失败");
    return payload.data;
}
