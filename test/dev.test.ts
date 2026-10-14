import { describe, expect, it } from "vitest";
import { classicScriptSources } from "../cli/dev.ts";

describe("classicScriptSources", () => {
  it("finds local non-module scripts only", () => {
    const html = `
      <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/88/three.min.js"></script>
      <script id="vertexShader" type="x-shader/x-vertex">void main(){}</script>
      <script type="module" src="./src/main.js"></script>
      <script src="./script.js" crossorigin></script>
      <script src="/lib/util.js"></script>`;
    expect(classicScriptSources(html)).toEqual(["./script.js", "./lib/util.js"]);
  });
});
