"use client";

import { Check, ChevronDown, Circle, CircleStop, Clock3, LoaderCircle, Pause, RotateCcw, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { agentTraceElapsedMs, type AgentExecutionStepStatus, type AgentExecutionTrace } from "@/lib/agent-execution-trace";
import { cn } from "@/lib/utils";

const phaseLabels: Record<AgentExecutionTrace["phase"], string> = {
    accepted: "已接收需求",
    planning: "理解需求与参考素材",
    skills: "检查 Skill 与可用能力",
    plan: "制定执行计划",
    executing: "执行创作任务",
    reviewing: "检查生成结果",
    delivering: "整理并交付结果",
};

const orderedPhases = Object.keys(phaseLabels) as AgentExecutionTrace["phase"][];

export function AgentExecutionTimeline({ trace, className, compact = false }: { trace: AgentExecutionTrace; className?: string; compact?: boolean }) {
    const terminal = trace.status === "completed" || trace.status === "failed" || trace.status === "cancelled";
    const [expanded, setExpanded] = useState(!terminal);
    const [, setClock] = useState(0);
    useEffect(() => {
        if (terminal) return;
        const timer = window.setInterval(() => setClock((value) => value + 1), 1000);
        return () => window.clearInterval(timer);
    }, [terminal]);
    useEffect(() => {
        if (!terminal) setExpanded(true);
    }, [terminal]);

    const elapsed = agentTraceElapsedMs(trace);
    const finishedTasks = trace.tasks.filter((task) => task.status === "completed").length;
    const failedTasks = trace.tasks.filter((task) => task.status === "failed").length;
    const header = terminal ? `${trace.status === "completed" ? "已完成" : trace.status === "failed" ? "执行失败" : "已取消"}${trace.tasks.length ? ` ${finishedTasks}/${trace.tasks.length} 项任务` : ""}` : trace.summary;
    const phases = useMemo(() => visiblePhases(trace), [trace]);

    return (
        <div
            className={cn("mt-2 max-w-[680px] overflow-hidden rounded-xl border border-stone-200/80 bg-white/70 text-stone-700 shadow-sm dark:border-stone-700/80 dark:bg-stone-900/65 dark:text-stone-200", compact && "text-xs", className)}
            aria-live="polite"
        >
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
                <TraceIcon status={traceStatus(trace)} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium sm:text-sm">{header}</span>
                {trace.connectionAttempt ? <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-300">连接恢复中</span> : null}
                {typeof elapsed === "number" ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-stone-400">
                        <Clock3 className="size-3" />
                        {formatDuration(elapsed)}
                    </span>
                ) : null}
                <ChevronDown className={cn("size-3.5 shrink-0 text-stone-400 transition", expanded && "rotate-180")} />
            </button>
            {expanded ? (
                <div className="border-t border-stone-200/70 px-3 py-2.5 dark:border-stone-700/70">
                    <div className="space-y-2">
                        {phases.map((phase) => (
                            <div key={phase.key} className={cn("flex items-start gap-2 text-xs leading-5", phase.status === "pending" && "opacity-45")}>
                                <TraceIcon status={phase.status} />
                                <span>{phaseLabels[phase.key]}</span>
                                {phase.key === "executing" && trace.tasks.length ? (
                                    <span className="text-stone-400">
                                        {finishedTasks + failedTasks}/{trace.tasks.length}
                                    </span>
                                ) : null}
                            </div>
                        ))}
                    </div>
                    {trace.tasks.length ? (
                        <div className="ml-[6px] mt-2.5 space-y-1.5 border-l border-stone-200 pl-4 dark:border-stone-700">
                            {trace.tasks.map((task) => (
                                <div key={task.id} className="flex min-w-0 items-start gap-2 text-[11px] leading-5 text-stone-500 dark:text-stone-400">
                                    <TraceIcon status={task.status} small />
                                    <span className="min-w-0 flex-1 break-words">{task.title}</span>
                                    {task.totalCount && task.totalCount > 1 ? (
                                        <span className="shrink-0">
                                            {task.completedCount || 0}/{task.totalCount}
                                            {task.failedCount ? ` · 失败 ${task.failedCount}` : ""}
                                        </span>
                                    ) : null}
                                    {task.attempts && task.attempts > 1 ? (
                                        <span className="inline-flex shrink-0 items-center gap-0.5">
                                            <RotateCcw className="size-2.5" />
                                            {task.attempts}
                                        </span>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function visiblePhases(trace: AgentExecutionTrace) {
    const activeIndex = orderedPhases.indexOf(trace.phase);
    const terminalStatus = trace.status === "failed" ? "failed" : trace.status === "cancelled" ? "cancelled" : "completed";
    return orderedPhases.slice(0, Math.max(activeIndex + 1, 1)).map((key, index): { key: AgentExecutionTrace["phase"]; status: AgentExecutionStepStatus } => ({
        key,
        status:
            index < activeIndex
                ? ("completed" as const)
                : index === activeIndex
                  ? trace.status === "paused"
                      ? ("paused" as const)
                      : trace.status === "completed" || trace.status === "failed" || trace.status === "cancelled"
                        ? terminalStatus
                        : ("running" as const)
                  : ("pending" as const),
    }));
}

function traceStatus(trace: AgentExecutionTrace): AgentExecutionStepStatus {
    if (trace.connectionAttempt) return "running";
    if (trace.status === "planning" || trace.status === "running") return "running";
    return trace.status;
}

function TraceIcon({ status, small = false }: { status: AgentExecutionStepStatus; small?: boolean }) {
    const className = cn(small ? "mt-1 size-2.5" : "mt-0.5 size-3.5", "shrink-0");
    if (status === "completed") return <Check className={cn(className, "text-emerald-500")} />;
    if (status === "running") return <LoaderCircle className={cn(className, "animate-spin text-sky-500")} />;
    if (status === "failed") return <XCircle className={cn(className, "text-red-500")} />;
    if (status === "paused") return <Pause className={cn(className, "text-amber-500")} />;
    if (status === "cancelled") return <CircleStop className={cn(className, "text-amber-500")} />;
    return <Circle className={cn(className, "text-stone-400")} />;
}

function formatDuration(milliseconds: number) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}
