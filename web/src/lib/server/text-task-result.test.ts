import { describe, expect, it } from "vitest";

import { normalizeTextTaskResult } from "./text-task-result";
import type { TextTask } from "./text-task-store";

describe("text task result normalization", () => {
    it("leaves ordinary text tasks unchanged", () => {
        expect(normalizeTextTaskResult(task(), "普通文本结果")).toBe("普通文本结果");
    });

    it("normalizes a drama content result before it is persisted", () => {
        const source = {
            episode: { outline: "测试大纲", hook: "开门", nextPreview: "下一集", sourceRange: "全文" },
            characters: [],
            scenes: [],
            props: [],
            clues: [],
            shots: [
                {
                    title: "开门",
                    description: "主角开门。",
                    sourceText: "主角说：开始。",
                    shotBoundary: "动作结束",
                    dialogue: "开始。",
                    narration: "",
                    utterances: [{ type: "dialogue", speaker: "主角", text: "开始。" }],
                    duration: 5,
                    characterNames: [],
                    sceneName: "",
                    propNames: [],
                    clueNames: [],
                },
            ],
        };
        const result = JSON.parse(normalizeTextTaskResult(task({ kind: "drama-analysis", phase: "content", defaultVideoSeconds: 5 }, [{ role: "user", content: JSON.stringify({ script: "主角说：开始。" }) }]), JSON.stringify(source)));

        expect(result.shots).toHaveLength(1);
        expect(result.shots[0]).toMatchObject({ sourceText: "主角说：开始。", dialogue: "开始。" });
        expect(result.shots[0].utterances[0].id).toMatch(/^utterance-/);
    });

    it("rejects drama content without usable shots", () => {
        expect(() => normalizeTextTaskResult(task({ kind: "drama-analysis", phase: "content", defaultVideoSeconds: 5 }), JSON.stringify({ episode: { outline: "空结果" }, characters: [], scenes: [], props: [], clues: [], shots: [] }))).toThrow(
            "模型没有返回结构化剧本结果",
        );
    });

    it("rejects a partial visual result", () => {
        const content = JSON.stringify({
            shots: [
                {
                    shotId: "shot-one",
                    imagePrompt: "首帧",
                    videoPrompt: "视频",
                    cameraMotion: "推进",
                    startFramePrompt: "开始",
                    endFramePrompt: "结束",
                    negativePrompt: "模糊",
                    continuity: {},
                },
            ],
        });

        expect(() => normalizeTextTaskResult(task({ kind: "drama-analysis", phase: "visual", shotIds: ["shot-one", "shot-two"] }), content)).toThrow("模型没有为全部镜头生成视觉结构");
    });
});

function task(metadata?: Record<string, unknown>, messages: TextTask["messages"] = [{ role: "user", content: "测试" }]): TextTask {
    return {
        id: "text-one",
        userId: "user-one",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        config: { baseUrl: "https://example.com", apiKey: "key", apiFormat: "openai", model: "text-model" },
        messages,
        metadata,
    };
}
