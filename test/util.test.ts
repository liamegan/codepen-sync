import { describe, expect, it } from "vitest";
import { UserError, idSuffix, parsePenRef, slugify } from "../cli/util.ts";

describe("slugify", () => {
  it("makes folder-safe names", () => {
    expect(slugify("GLSL: In the Sacred Realm")).toBe("glsl-in-the-sacred-realm");
    expect(slugify('"Masonry" images')).toBe("masonry-images");
    expect(slugify("Crème brûlée")).toBe("creme-brulee");
    expect(slugify("!!!")).toBe("untitled");
  });
});

describe("parsePenRef", () => {
  it("accepts ids", () => {
    expect(parsePenRef("01a10e01-ac64-7d4c-a9d3-f08a20497a99")).toBe("01a10e01-ac64-7d4c-a9d3-f08a20497a99");
    expect(parsePenRef("XZEvKp")).toBe("XZEvKp");
  });

  it("accepts editor and Classic URLs", () => {
    expect(parsePenRef("https://codepen.io/editor/someone/pen/01a10e01-ac64-7d4c-a9d3-f08a20497a99/01a10e01-0000-7d4c-a9d3-f08a20497a99")).toBe(
      "01a10e01-ac64-7d4c-a9d3-f08a20497a99",
    );
    expect(parsePenRef("https://codepen.io/someone/pen/EaNWMVY")).toBe("EaNWMVY");
    expect(parsePenRef("https://codepen.io/someone/full/EaNWMVY?editors=0010")).toBe("EaNWMVY");
  });

  it("rejects URLs without a Pen id", () => {
    for (const url of [
      "https://pv-01a137b6-5355-7fd7-be5e-1f4f682b98a9.codepen.dev/",
      "https://my-pen.codepen.app/",
      "https://codepen.io/collection/QbaoZL",
      "https://example.com/someone/pen/abc123",
    ]) {
      expect(() => parsePenRef(url), url).toThrow(UserError);
    }
  });

  it("treats slugs as local names", () => {
    expect(parsePenRef("manifold-mandala")).toBeNull();
    expect(parsePenRef("strings")).toBeNull();
  });
});

describe("idSuffix", () => {
  it("takes the last six id characters, lowercased", () => {
    expect(idSuffix("01a137b6-52d7-7fd6-b5c7-2f745f848ca1")).toBe("848ca1");
    expect(idSuffix("EaNWMVY")).toBe("anwmvy");
  });
});
