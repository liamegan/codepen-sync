import { describe, expect, it } from "vitest";
import { parsePenRef, slugify } from "../cli/util.ts";

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

  it("treats slugs as local names", () => {
    expect(parsePenRef("manifold-mandala")).toBeNull();
    expect(parsePenRef("strings")).toBeNull();
  });
});
