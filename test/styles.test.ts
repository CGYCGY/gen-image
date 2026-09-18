// Style resolution as the CLI performs it: order is precedence, per-image REPLACES the
// top-level list, and the merged text is what actually reaches the backend.

import { describe, expect, test } from "bun:test";

import { existingImage, outPath } from "./helpers.ts";
import { buildJobs, run } from "../cli/render.ts";
import { listStyles, orientationOf, resolveStyles, SIZE_WON } from "../shared/styles.ts";

describe("style resolution", () => {
  test("contested properties resolve last-wins in caller order", () => {
    // icon sets orientation + text; poster sets only orientation, so it wins that one alone.
    const res = resolveStyles(["icon", "poster"]);
    expect(res.props.orientation).toBe("portrait");
    expect(res.won.orientation).toBe("poster");
    expect(res.props.text).toBe("none");
    expect(res.won.text).toBe("icon");
    expect(resolveStyles(["poster", "icon"]).props.orientation).toBe("square-1x1");
  });

  test("the resolved block is emitted last so prose cannot contradict it", () => {
    const res = resolveStyles(["watercolor", "poster"]);
    expect(res.text.indexOf("Watercolor look")).toBeLessThan(res.text.indexOf("These override anything above:"));
  });

  test("a name resolves across both axes", () => {
    const { looks, forms } = listStyles();
    expect(looks).toContain("watercolor");
    expect(forms).toContain("poster");
    expect(resolveStyles(["watercolor"]).files[0]?.axis).toBe("look");
  });

  test("the merged text is prepended to the image's own prompt", () => {
    const [job] = buildJobs({ style: ["watercolor"], images: [{ prompt: "a fox", out_path: outPath("a.png") }] });
    expect(job?.request.op).toBe("generate");
    const prompt = job?.request.op === "generate" ? job.request.prompt : "";
    expect(prompt.startsWith(resolveStyles(["watercolor"]).text)).toBe(true);
    expect(prompt.endsWith("a fox")).toBe(true);
    expect(job?.styles).toEqual(["watercolor"]);
  });

  test("an edit's instruction is styled the same way", () => {
    const [job] = buildJobs({
      style: ["neon"],
      images: [{ op: "edit", instruction: "brighter", input_path: existingImage(), out_path: outPath("b.png") }],
    });
    const text = job?.request.op === "edit" ? job.request.instruction : "";
    expect(text.startsWith(resolveStyles(["neon"]).text)).toBe(true);
    expect(text.endsWith("brighter")).toBe(true);
  });

  test("a per-image style REPLACES the top-level list", async () => {
    const out = await run([
      "--dry-run",
      JSON.stringify({
        style: ["watercolor", "poster"],
        images: [
          { prompt: "inherits", out_path: outPath("a.png") },
          { prompt: "overrides", out_path: outPath("b.png"), style: ["neon"] },
          { prompt: "opts out", out_path: outPath("c.png"), style: [] },
        ],
      }),
    ]);
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    expect(out.images.map((i) => i.styles)).toEqual([["watercolor", "poster"], ["neon"], []]);
  });

  test("a bare string is accepted as a one-name list", () => {
    const [job] = buildJobs({ style: "watercolor", images: [{ prompt: "a", out_path: outPath("a.png") }] });
    expect(job?.styles).toEqual(["watercolor"]);
  });

  test("no style leaves the prompt untouched", () => {
    const [job] = buildJobs({ images: [{ prompt: "a fox", out_path: outPath("a.png") }] });
    expect(job?.request.op === "generate" && job.request.prompt).toBe("a fox");
  });
});

describe("size versus orientation", () => {
  test("a size reads as shape, reduced ratio and exact pixels", () => {
    expect(orientationOf("1536x1024")).toBe("landscape 3:2, exactly 1536x1024 pixels");
    expect(orientationOf("1024x1536")).toBe("portrait 2:3, exactly 1024x1536 pixels");
    expect(orientationOf("1024x1024")).toBe("square 1:1, exactly 1024x1024 pixels");
    // 1672:941 does not reduce; a ratio nobody can picture is left out.
    expect(orientationOf("1672x941")).toBe("landscape, exactly 1672x941 pixels");
    expect(orientationOf("wide")).toBeUndefined();
    expect(orientationOf("0x100")).toBeUndefined();
  });

  test("an explicit size displaces the form's orientation in the override block", () => {
    // infographic is 16:9; the caller asked for 3:2. Before this the prompt carried both and 16:9 won.
    const res = resolveStyles(["infographic"], { size: "1536x1024" });
    expect(res.props.orientation).toBe("landscape 3:2, exactly 1536x1024 pixels");
    expect(res.won.orientation).toBe(SIZE_WON);
    expect(res.props.text).toBe("required"); // the other contested key is untouched
    expect(res.text).not.toContain("landscape-16x9");
    expect(res.text).toContain("- orientation: landscape 3:2, exactly 1536x1024 pixels");
  });

  test("a size alone still yields the override block", () => {
    const res = resolveStyles([], { size: "1024x1536" });
    expect(res.files).toEqual([]);
    expect(res.text).toBe("These override anything above:\n- orientation: portrait 2:3, exactly 1024x1536 pixels");
  });

  test("the size block is prepended to an unstyled prompt too", () => {
    const [job] = buildJobs({ images: [{ prompt: "a fox", out_path: outPath("a.png"), size: "1024x1536" }] });
    const prompt = job?.request.op === "generate" ? job.request.prompt : "";
    expect(prompt.startsWith("These override anything above:\n- orientation: portrait 2:3")).toBe(true);
    expect(prompt.endsWith("\n\na fox")).toBe(true);
    expect(job?.request.size).toBe("1024x1536");
  });

  test("a bad size is rejected as a spec error", () => {
    expect(() => buildJobs({ images: [{ prompt: "a", out_path: outPath("a.png"), size: "wide" }] })).toThrow(
      'images[0].size must be "WxH" in pixels',
    );
  });
});
