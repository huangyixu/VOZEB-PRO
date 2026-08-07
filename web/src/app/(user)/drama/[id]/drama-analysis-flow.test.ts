import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Drama analysis page flow", () => {
    it("uses the persistent analysis task flow for content and visual phases", async () => {
        const [page, reviewPanel] = await Promise.all([readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/page.tsx"), "utf8"), readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-review-panel.tsx"), "utf8")]);

        expect(page).not.toContain('fetch("/api/drama/analyze"');
        expect(page.match(/await runDramaAnalysis\(/g)).toHaveLength(2);
        expect(page).toContain('{ phase: "content", projectId: project.id, episodeId');
        expect(page).toContain('{ phase: "visual", projectId: project.id, episodeId');
        expect(page).toContain("AI 正在提取内容结构…");
        expect(reviewPanel).toContain("AI 正在生成视觉方案…");
    });

    it("aborts stale requests and refuses to apply results after their inputs change", async () => {
        const page = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/page.tsx"), "utf8");

        expect(page).toContain("analysisControllerRef.current?.abort()");
        expect(page).toContain("if (stageEpisodeIdRef.current !== episode.id)");
        expect(page).toContain("currentEpisode.script !== sourceScript");
        expect(page).toContain("currentProject.summary !== sourceSummary");
        expect(page).toContain("currentProject.style !== sourceStyle");
        expect(page).toContain("current.updatedAt !== sourceUpdatedAt");
        expect(page).toMatch(/onChange=\{\(episodeId\) => \{\s*cancelAnalysisRequest\(\);\s*selectEpisode/);
        expect(page).toContain("void createVersion(snapshot, reason).catch");
        expect(page).not.toContain("await saveAnalysisSnapshot");
    });

    it("restores the workflow stage from the saved review status", async () => {
        const page = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/page.tsx"), "utf8");
        const restoreStage = page.slice(page.indexOf("function restoredDramaStage"), page.indexOf("function isAbortError"));

        expect(restoreStage).toContain('episode.reviewStatus === "visual_ready"');
        expect(restoreStage).toContain('return "storyboard"');
        expect(restoreStage).toContain('episode.reviewStatus === "content_review" || episode.reviewStatus === "approved"');
        expect(restoreStage).toContain('return "review"');
        expect(restoreStage).toContain('return "script"');
        expect(page).toContain('setStage(restoredEpisode ? restoredDramaStage(restoredEpisode) : "script")');
    });
});
