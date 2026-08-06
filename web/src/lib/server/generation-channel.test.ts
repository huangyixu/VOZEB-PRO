import { describe, expect, it } from "vitest";

import { channelSupportsModel, generationModelId, resolveModelAdvancedConfig, resolveSystemGenerationChannel, systemGenerationChannelId, toSystemGenerationChannel } from "./generation-channel";

const channels = [{ id: "channel-1", enabled: true, apiFormat: "gemini" as const, models: ["models/video-v1"] }];

describe("resolveSystemGenerationChannel", () => {
    it("uses the logical model id for public records and billing", () => {
        expect(generationModelId({ model: "vendor/model-v2", logicalModel: "writer" })).toBe("writer");
        expect(generationModelId({ model: "vendor/model-v2" })).toBe("vendor/model-v2");
    });

    it("uses the canonical enabled backend channel settings", () => {
        expect(resolveSystemGenerationChannel({ apiSource: "system", baseUrl: "/api/ai/system/channel-1", apiFormat: "openai", model: "video-v1" }, channels)).toEqual({
            apiSource: "system",
            baseUrl: "/api/ai/system/channel-1",
            apiKey: "system",
            apiFormat: "gemini",
            model: "video-v1",
        });
    });

    it("rejects disabled, unknown, malformed, and unlisted models", () => {
        expect(resolveSystemGenerationChannel({ apiSource: "system", baseUrl: "/api/ai/system/missing", model: "video-v1" }, channels)).toBeNull();
        expect(resolveSystemGenerationChannel({ apiSource: "system", baseUrl: "/api/ai/system/channel-1/extra", model: "video-v1" }, channels)).toBeNull();
        expect(resolveSystemGenerationChannel({ apiSource: "system", baseUrl: "/api/ai/system/channel-1", model: "other" }, channels)).toBeNull();
        expect(resolveSystemGenerationChannel({ apiSource: "system", baseUrl: "/api/ai/system/channel-1", model: "video-v1" }, [{ ...channels[0], enabled: false }])).toBeNull();
    });

    it("extracts only an exact system channel path", () => {
        expect(systemGenerationChannelId("/api/ai/system/channel-1")).toBe("channel-1");
        expect(systemGenerationChannelId("/api/ai/system/channel-1/extra")).toBe("");
        expect(systemGenerationChannelId("/api/ai/system/%E0%A4%A")).toBe("");
    });

    it("matches model prefixes and casing consistently", () => {
        expect(channelSupportsModel(["models/Video-V1"], "video-v1")).toBe(true);
        expect(channelSupportsModel(["video-v1"], "models/VIDEO-V1")).toBe(true);
        expect(channelSupportsModel(["video-v2"], "video-v1")).toBe(false);
    });

    it("resolves create and query paths per model on a mixed company channel", () => {
        const advanced = {
            protocol: "auto",
            createPath: "",
            queryPath: "",
            modelConfigs: {
                "openai-text": { capability: "text", apiFormat: "openai", createPath: "/chat/completions" },
                "sd2.0": { capability: "video", apiFormat: "openai", protocol: "seedance", createPath: "/videos", queryPath: "/videos/:task_id" },
            },
        } as never;

        expect(resolveModelAdvancedConfig(advanced, "openai-text")).toMatchObject({ createPath: "/chat/completions", queryPath: "" });
        expect(resolveModelAdvancedConfig(advanced, "sd2.0")).toMatchObject({ protocol: "seedance", createPath: "/videos", queryPath: "/videos/:task_id" });
    });

    it("keeps a model-level reference override over a Global AI OPC preset", () => {
        const advanced = {
            protocol: "globalaiopc",
            globalAiOpcPresets: ["video-happyhorse-i2v"],
            modelConfigs: { "happyhorse-1.1-i2v": { capability: "video", supportsReferenceImage: false } },
        } as never;

        expect(resolveModelAdvancedConfig(advanced, "happyhorse-1.1-i2v")).toMatchObject({ createPath: "/happyhorse-i2v/videos", supportsReferenceImage: false });
    });

    it("preserves the top-level channel protocol when a model overrides its protocol", () => {
        const config = toSystemGenerationChannel({
            logicalModelId: "seedance-2.0",
            upstreamModel: "doubao-sd-2.0",
            channelId: "new-api",
            channel: {
                id: "new-api",
                name: "New API",
                baseUrl: "https://new-api.example.com",
                apiKey: "secret",
                apiFormat: "openai",
                models: ["doubao-sd-2.0"],
                enabled: true,
                advancedConfig: {
                    protocol: "newapi",
                    modelConfigs: {
                        "doubao-sd-2.0": {
                            capability: "video",
                            protocol: "openai",
                            createPath: "/videos",
                            requestTemplate: "multipart/form-data: model、prompt、seconds、size、input_reference",
                        },
                    },
                },
            } as never,
        });

        expect(config.channelProtocol).toBe("newapi");
        expect(config.advancedConfig?.protocol).toBe("openai");
    });
});
