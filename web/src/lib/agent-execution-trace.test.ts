import { describe, expect, it } from "vitest";

import { agentExecutionTraceFromRun, applyAgentExecutionEvent, markAgentTraceReconnecting } from "./agent-execution-trace";

describe("Agent execution trace", () => {
    it("keeps completed child progress while later events arrive", () => {
        let trace = agentExecutionTraceFromRun({ id: "run-1", status: "planning", tasks: [], timings: { requestAcceptedAt: 100 } });
        trace = applyAgentExecutionEvent(trace, "run.planning", { data: {} });
        trace = applyAgentExecutionEvent(trace, "skills.selected", { data: {} });
        trace = applyAgentExecutionEvent(trace, "task.child.completed", { data: { taskId: "task-1", title: "生成分镜图", completedCount: 2, failedCount: 0, totalCount: 4 } });

        expect(trace.phase).toBe("executing");
        expect(trace.tasks[0]).toMatchObject({ id: "task-1", title: "生成分镜图", status: "running", completedCount: 2, totalCount: 4 });

        trace = applyAgentExecutionEvent(trace, "task.completed", { data: { taskId: "task-1", title: "生成分镜图" } });
        expect(trace.tasks[0]).toMatchObject({ status: "completed", completedCount: 2, totalCount: 4 });
    });

    it("restores phase, task counts and duration anchors from a run snapshot", () => {
        const trace = agentExecutionTraceFromRun({
            id: "run-2",
            status: "running",
            timings: { requestAcceptedAt: 100, planningCompletedAt: 200, firstTaskSubmittedAt: 250 },
            tasks: [{ id: "task-2", title: "生成视频", type: "video", status: "running", count: 2, childTasks: [{ status: "completed" }, { status: "pending" }] }],
        });

        expect(trace.phase).toBe("executing");
        expect(trace.startedAt).toBe(100);
        expect(trace.tasks[0]).toMatchObject({ completedCount: 1, totalCount: 2 });
    });

    it("shows reconnecting without discarding the current phase", () => {
        const trace = markAgentTraceReconnecting(agentExecutionTraceFromRun({ id: "run-3", status: "running", tasks: [], timings: { requestAcceptedAt: 100, planningCompletedAt: 200 } }), 2);
        expect(trace.phase).toBe("plan");
        expect(trace.connectionAttempt).toBe(2);
    });
});
