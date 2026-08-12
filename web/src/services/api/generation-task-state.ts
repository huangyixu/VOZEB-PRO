export type GenerationTaskExecutionState = {
    needsReview?: boolean;
    executionPhase?: string;
};

export const GENERATION_TASK_NEEDS_REVIEW_MESSAGE = "生成失败，请联系管理员";

export class GenerationTaskNeedsReviewError extends Error {
    constructor(message = GENERATION_TASK_NEEDS_REVIEW_MESSAGE) {
        super(message);
        this.name = "GenerationTaskNeedsReviewError";
    }
}

export function isGenerationTaskNeedsReviewError(error: unknown) {
    return error instanceof GenerationTaskNeedsReviewError || (error instanceof Error && error.message === GENERATION_TASK_NEEDS_REVIEW_MESSAGE);
}
