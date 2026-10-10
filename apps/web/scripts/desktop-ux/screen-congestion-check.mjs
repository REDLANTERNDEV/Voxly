import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VOXLY_TEST_BROWSER_PATH ? { executablePath: process.env.VOXLY_TEST_BROWSER_PATH } : {})
});
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:1422/features.html");
  const results = await page.evaluate(() => window.screenBenchmark(20, false, true));
  const healthy = results.find((result) => result.mode === "native"),
    constrained = results.find((result) => result.mode === "adaptive");
  assert.ok(healthy.samples.some((sample) => sample.receivedHeight === 720 && sample.decodedFrames > 0));
  assert.ok(constrained.samples.some((sample) => sample.receivedHeight === 360 && sample.decodedFrames > 0));
  assert.ok(constrained.samples.slice(-5).some((sample) => sample.receivedHeight === 720 && sample.decodedFrames > 0));
  assert.ok(healthy.samples.slice(-5).every((sample) => sample.receivedHeight === 720));
  console.log(
    JSON.stringify({
      fixture: "direct local WebRTC with synthetic congestion reports; not packet impairment",
      healthyLast: healthy.samples.at(-1),
      constrainedFirst360: constrained.samples.find((sample) => sample.receivedHeight === 360),
      constrainedLast: constrained.samples.at(-1)
    })
  );
} finally {
  await browser.close();
}
