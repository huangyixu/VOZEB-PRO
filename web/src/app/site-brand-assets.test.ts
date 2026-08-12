import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SITE_SETTINGS } from "@/lib/auth/store";

describe("default infinite-evolution brand assets", () => {
    it("uses the built-in whale logo for every default brand entry", () => {
        expect(DEFAULT_SITE_SETTINGS.logoUrl).toBe("/logo.png");
        expect(DEFAULT_SITE_SETTINGS.iconUrl).toBe("/icon.png");
    });

    it("keeps the PNG whale source synchronized across the web and docs defaults", async () => {
        const [logo, icon, docsLogo, docsIcon] = await Promise.all([
            readFile(resolve(process.cwd(), "public/logo.png")),
            readFile(resolve(process.cwd(), "public/icon.png")),
            readFile(resolve(process.cwd(), "../docs/public/logo.png")),
            readFile(resolve(process.cwd(), "../docs/public/icon.png")),
        ]);

        expect(logo.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(docsLogo).toEqual(logo);
        expect(icon.length).toBeGreaterThan(10_000);
        expect(docsIcon).toEqual(icon);
    });
});
