import { describe, expect, it } from "vitest";

import { DEFAULT_SITE_SETTINGS } from "@/lib/auth/store";
import { browserIconHref } from "./site-metadata";

describe("site metadata", () => {
    it("keeps the bundled browser icon on the same origin", () => {
        expect(browserIconHref(DEFAULT_SITE_SETTINGS)).toBe("/icon.png");
    });

    it("uses a custom logo when the browser icon is still the bundled default", () => {
        expect(browserIconHref({ iconUrl: "/icon.png", logoUrl: "/custom-logo.png" })).toBe("/custom-logo.png");
    });

    it("keeps an independently configured browser icon", () => {
        expect(browserIconHref({ iconUrl: "https://cdn.example.com/favicon.png", logoUrl: "/custom-logo.png" })).toBe("https://cdn.example.com/favicon.png");
    });
});
