import { describe, expect, it } from "vitest";

import { DEFAULT_SITE_SETTINGS } from "./store-foundation";
import { normalizeSiteSettings } from "./store-normalizers";

describe("site settings", () => {
    it("uses the bundled browser icon when older settings have no icon URL", () => {
        expect(normalizeSiteSettings({ logoUrl: "/custom-logo.png" }).iconUrl).toBe(DEFAULT_SITE_SETTINGS.iconUrl);
    });

    it("accepts a configured browser icon independently from the logo", () => {
        const settings = normalizeSiteSettings({ logoUrl: "/brand.svg", iconUrl: "https://cdn.example.com/favicon.ico" });

        expect(settings.logoUrl).toBe("/brand.svg");
        expect(settings.iconUrl).toBe("https://cdn.example.com/favicon.ico");
    });

    it("upgrades the previous default brand name and asset paths", () => {
        const settings = normalizeSiteSettings({ title: ["VenLinks", "PRO"].join(" "), seoTitle: ["VenLinks", "Pro"].join(" "), logoUrl: "/logo.svg", iconUrl: "/icon.svg" });

        expect(settings).toMatchObject({ title: "VenLinks", seoTitle: "VenLinks", logoUrl: "/logo.png", iconUrl: "/icon.png" });
    });

    it("defaults public contacts without friend links", () => {
        const settings = normalizeSiteSettings({});

        expect(settings.socials.email).toMatchObject({ enabled: true, url: "mailto:csyqlz@gmail.com" });
        expect(settings.socials.telegram).toMatchObject({ enabled: false, url: "" });
        expect(settings.socials.x).toMatchObject({ enabled: false, url: "" });
        expect(settings.socials.instagram).toMatchObject({ enabled: false, url: "" });
        expect(settings.friendLinks).toEqual([]);
    });

    it("keeps an explicitly emptied friend-link list empty", () => {
        expect(normalizeSiteSettings({ friendLinks: [] }).friendLinks).toEqual([]);
    });

    it("preserves only explicitly configured friend links", () => {
        const configured = [{ id: "custom", label: "示例", url: "https://example.com/", enabled: true }];

        expect(normalizeSiteSettings({ friendLinks: configured }).friendLinks).toEqual(configured);
    });
});
