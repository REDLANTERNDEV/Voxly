import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VOXLY_TEST_BROWSER_PATH ? { executablePath: process.env.VOXLY_TEST_BROWSER_PATH } : {})
});
const trials = [];
try {
  for (const late of [false, true])
    for (let trial = 1; trial <= 5; trial++) {
      const page = await browser.newPage();
      await page.goto("http://127.0.0.1:1422/features.html");
      const results = await page.evaluate((late) => window.screenBenchmark(6, late), late);
      const adaptive = results.find((r) => r.mode === "adaptive");
      trials.push({ lateViewer: late, trial, ...adaptive });
      console.log(
        JSON.stringify({
          lateViewer: late,
          trial,
          first720pMs: adaptive.first720pMs,
          frames: adaptive.samples.at(-1).decodedFrames
        })
      );
      await page.close();
    }
  await writeFile("/private/tmp/voxly-screen-trials.json", JSON.stringify(trials, null, 2));
} finally {
  await browser.close();
}
if (trials.some((t) => t.first720pMs === null || t.first720pMs > 5000)) process.exitCode = 1;
