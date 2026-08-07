import { dramaContentTool, dramaVisualTool, hasUsableDramaToolArguments, normalizeDramaContentAnalysis, normalizeDramaVisualAnalysis } from "@/lib/server/drama-analysis";
import { strictJsonObjectText } from "@/lib/server/structured-model-output";
import type { TextTask } from "@/lib/server/text-task-store";

type DramaAnalysisMetadata = {
    kind: "drama-analysis";
    phase: "content" | "visual";
    defaultVideoSeconds?: number;
    shotIds?: string[];
};

export function normalizeTextTaskResult(task: TextTask, content: string) {
    const metadata = dramaAnalysisMetadata(task.metadata);
    if (!metadata) return content;

    const json = strictJsonObjectText(content);
    const tool = metadata.phase === "visual" ? dramaVisualTool : dramaContentTool;
    if (!json || !hasUsableDramaToolArguments(json, tool.name)) throw new Error("模型没有返回结构化剧本结果");

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error("模型返回的剧本结构不是有效 JSON");
    }

    if (metadata.phase === "visual") {
        const shotIds = cleanShotIds(metadata.shotIds);
        const result = normalizeDramaVisualAnalysis(parsed, shotIds);
        if (!shotIds.length || result.shots.length !== shotIds.length) throw new Error("模型没有为全部镜头生成视觉结构");
        return JSON.stringify(result);
    }

    const result = normalizeDramaContentAnalysis(parsed, positiveInteger(metadata.defaultVideoSeconds, 5), contentSourceScript(task));
    if (!result.shots.length) throw new Error("模型没有生成有效内容结构");
    return JSON.stringify(result);
}

function dramaAnalysisMetadata(value: TextTask["metadata"]): DramaAnalysisMetadata | null {
    if (!value || value.kind !== "drama-analysis" || (value.phase !== "content" && value.phase !== "visual")) return null;
    return value as DramaAnalysisMetadata;
}

function contentSourceScript(task: TextTask) {
    for (const message of task.messages) {
        if (message.role !== "user" || typeof message.content !== "string") continue;
        try {
            const source = JSON.parse(message.content) as { script?: unknown };
            if (typeof source.script === "string") return source.script;
        } catch {
            // Other text tasks may use natural-language user messages.
        }
    }
    return "";
}

function cleanShotIds(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function positiveInteger(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
