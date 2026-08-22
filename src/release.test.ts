import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "./main.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("release metadata", () => {
  it("keeps the package and runtime versions aligned", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    ) as {
      version: string;
      license: string;
      repository: { type: string; url: string };
      publishConfig: { access: string; provenance: boolean };
    };

    expect(VERSION).toBe(manifest.version);
    expect(manifest).toMatchObject({
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/CorbinCald/kb-drop-cli.git",
      },
      publishConfig: {
        access: "public",
        provenance: true,
      },
    });
  });

  it("ships the MIT license", async () => {
    const license = await readFile(resolve(packageRoot, "LICENSE"), "utf8");

    expect(license).toContain("MIT License");
    expect(license).toContain("Permission is hereby granted, free of charge");
  });
});
