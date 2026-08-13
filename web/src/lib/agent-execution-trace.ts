export type AgentExecutionStepStatus = "pending" | "running" | "completed" | "failed" | "paused" | "cancelled";

export type AgentExecutionTask = {
    id: string;
    title: string;
    type?: "text" | "image" | "video" | "audio";
    status: AgentExecutionStepStatus;
    completedCount?: number;
    failedCount?: number;
    totalCount?: number;
    attempts?: number;
    error?: string;
};

export type AgentExecutionTrace = {
    runId: string;
    status: "planning" | "running" | "paused" | "completed" | "failed" | "cancelled";
    phase: "accepted" | "planning" | "skills" | "plan" | "executing" | "reviewing" | "delivering";
    summary: string;
    startedAt?: number;
    completedAt?: number;
    planningCompletedAt?: number;
    reviewCompletedAt?: number;
    tasks: AgentExecutionTask[];
    connectionAttempt?: number;
};

export type AgentRunTimingSnapshot = {
    requestAcceptedAt: number;
    planningStartedAt?: number;
    planningCompletedAt?: number;
    firstTaskSubmittedAt?: number;
    firstResultReadyAt?: number;
    allResultsReadyAt?: number;
    reviewCompletedAt?: number;
    runCompletedAt?: number;
};

export type AgentRunTaskSnapshot = {
    id: string;
    title: string;
    type?: "text" | "image" | "video" | "audio";
    status: "ready" | "running" | "completed" | "failed" | "cancelled";
    attempts?: number;
    count?: number;
    childTasks?: Array<{ status: "pending" | "completed" | "failed" | "cancelled" }>;
    error?: string;
};

export type AgentRunTraceSnapshot = {
    id: string;
    status: AgentExecutionTrace["status"];
    tasks?: AgentRunTaskSnapshot[];
    timings?: AgentRunTimingSnapshot;
};

type TraceEventPayload = {
    status?: string;
    tasks?: AgentRunTaskSnapshot[];
    timings?: AgentRunTimingSnapshot;
    data?: Record<string, unknown>;
};

export function agentExecutionTraceFromRun(run: AgentRunTraceSnapshot): AgentExecutionTrace {
    const timings = run.timings;
    const tasks = (run.tasks || []).map(taskFromSnapshot);
    const phase = phaseFromSnapshot(run.status, tasks, timings);
    return {
        runId: run.id,
        status: run.status,
        phase,
        summary: summaryForPhase(phase, run.status),
        startedAt: timings?.requestAcceptedAt,
        completedAt: timings?.runCompletedAt,
        planningCompletedAt: timings?.planningCompletedAt,
        reviewCompletedAt: timings?.reviewCompletedAt,
        tasks,
    };
}

export function applyAgentExecutionEvent(current: AgentExecutionTrace, type: string, payload: TraceEventPayload): AgentExecutionTrace {
    const data = payload.data || {};
    if (type === "run.snapshot") {
        const snapshot = agentExecutionTraceFromRun({
            id: current.runId,
            status: isRunStatus(payload.status) ? payload.status : current.status,
            tasks: payload.tasks,
            timings: payload.timings,
        });
        return { ...snapshot, connectionAttempt: current.connectionAttempt };
    }

    const next = { ...current, tasks: [...current.tasks], connectionAttempt: undefined };
    if (type === "run.planning") return updatePhase(next, "planning", "正在理解需求与参考素材", "running");
    if (type === "skills.selected") return updatePhase(next, "skills", "已检查 Skill、模型与可用能力", "running");
    if (type === "run.planned" || type === "canvas.ops") return updatePhase(next, "plan", taskPlanSummary(data), "running");
    if (type === "task.running" || type === "task.created" || type === "task.child.completed" || type === "task.child.failed" || type === "task.completed" || type === "task.failed") {
        next.phase = "executing";
        next.status = "running";
        next.summary = "正在执行创作任务";
        next.tasks = upsertEventTask(next.tasks, type, data);
        return next;
    }
    if (type === "run.review.retry") return updatePhase(next, "reviewing", "发现可优化内容，正在重试", "running");
    if (type === "run.review.passed") return updatePhase(next, "delivering", "检查完成，正在整理结果", "running");
    if (type === "run.review.unavailable") return updatePhase(next, "delivering", "正在整理已完成结果", "running");
    if (type === "project.handoff") return updatePhase(next, "delivering", "正在创建并交付项目", "running");
    if (type === "run.paused") return { ...next, status: "paused", summary: "任务已暂停" };
    if (type === "run.resumed") return { ...next, status: "running", summary: "任务已恢复，正在继续执行" };
    if (type === "run.completed") return terminalTrace(next, "completed", "全部操作已完成");
    if (type === "run.failed") return terminalTrace(next, "failed", stringValue(data.message) || "执行失败");
    if (type === "run.cancelled") return terminalTrace(next, "cancelled", "执行已取消");
    return next;
}

export function markAgentTraceReconnecting(current: AgentExecutionTrace, attempt: number) {
    return { ...current, connectionAttempt: attempt, summary: `连接暂时中断，正在进行第 ${attempt} 次恢复` };
}

export function agentTraceElapsedMs(trace: AgentExecutionTrace, now = Date.now()) {
    if (!trace.startedAt) return undefined;
    return Math.max(0, (trace.completedAt || now) - trace.startedAt);
}

function updatePhase(trace: AgentExecutionTrace, phase: AgentExecutionTrace["phase"], summary: string, status: AgentExecutionTrace["status"]): AgentExecutionTrace {
    return { ...trace, phase, summary, status };
}

function terminalTrace(trace: AgentExecutionTrace, status: "completed" | "failed" | "cancelled", summary: string): AgentExecutionTrace {
    return { ...trace, phase: "delivering", status, summary, completedAt: trace.completedAt || Date.now(), connectionAttempt: undefined };
}

function taskFromSnapshot(task: AgentRunTaskSnapshot): AgentExecutionTask {
    const children = task.childTasks || [];
    return {
        id: task.id,
        title: task.title || "创作任务",
        type: task.type,
        status: task.status === "ready" ? "pending" : task.status,
        attempts: task.attempts,
        completedCount: children.filter((child) => child.status === "completed").length,
        failedCount: children.filter((child) => child.status === "failed").length,
        totalCount: Math.max(task.count || 1, children.length),
        error: task.error,
    };
}

function upsertEventTask(tasks: AgentExecutionTask[], eventType: string, data: Record<string, unknown>) {
    const id = stringValue(data.taskId) || `task-${tasks.length + 1}`;
    const existing = tasks.find((task) => task.id === id);
    const status: AgentExecutionStepStatus = eventType === "task.completed" ? "completed" : eventType === "task.failed" ? "failed" : "running";
    const next: AgentExecutionTask = {
        id,
        title: stringValue(data.title) || existing?.title || "创作任务",
        type: isTaskType(data.type) ? data.type : existing?.type,
        status,
        attempts: nonNegative(data.attempts) || existing?.attempts,
        completedCount: eventType.includes("child") ? nonNegative(data.completedCount) : existing?.completedCount,
        failedCount: eventType.includes("child") ? nonNegative(data.failedCount) : existing?.failedCount,
        totalCount: eventType.includes("child") ? Math.max(1, nonNegative(data.totalCount)) : existing?.totalCount,
        error: stringValue(data.error) || existing?.error,
    };
    return existing ? tasks.map((task) => (task.id === id ? next : task)) : [...tasks, next];
}

function phaseFromSnapshot(status: AgentExecutionTrace["status"], tasks: AgentExecutionTask[], timings?: AgentRunTimingSnapshot): AgentExecutionTrace["phase"] {
    if (status === "completed" || status === "failed" || status === "cancelled" || timings?.reviewCompletedAt) return "delivering";
    if (timings?.allResultsReadyAt) return "reviewing";
    if (tasks.length || timings?.firstTaskSubmittedAt) return "executing";
    if (timings?.planningCompletedAt) return "plan";
    return "planning";
}

function summaryForPhase(phase: AgentExecutionTrace["phase"], status: AgentExecutionTrace["status"]) {
    if (status === "completed") return "全部操作已完成";
    if (status === "failed") return "执行失败";
    if (status === "cancelled") return "执行已取消";
    if (status === "paused") return "任务已暂停";
    if (phase === "executing") return "正在执行创作任务";
    if (phase === "reviewing") return "正在检查生成结果";
    if (phase === "delivering") return "正在整理生成结果";
    if (phase === "plan") return "已制定执行计划";
    return "正在理解需求与参考素材";
}

function taskPlanSummary(data: Record<string, unknown>) {
    const count = Array.isArray(data.tasks) ? data.tasks.length : nonNegative(data.taskCount);
    return count ? `已制定执行计划 · ${count} 项任务` : "已制定执行计划";
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function nonNegative(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function isRunStatus(value: unknown): value is AgentExecutionTrace["status"] {
    return typeof value === "string" && ["planning", "running", "paused", "completed", "failed", "cancelled"].includes(value);
}

function isTaskType(value: unknown): value is NonNullable<AgentExecutionTask["type"]> {
    return typeof value === "string" && ["text", "image", "video", "audio"].includes(value);
}
