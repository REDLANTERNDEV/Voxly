import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

if (process.env.VOICE_LAB_ISOLATED !== "1" || process.platform !== "linux")
  throw new Error("Use the dedicated lab container");
const turnSecret = randomBytes(32).toString("hex");
const turn = spawn(
  "turnserver",
  [
    "--no-cli",
    "--no-tls",
    "--no-dtls",
    "--listening-ip=127.0.0.1",
    "--relay-ip=127.0.0.1",
    "--allow-loopback-peers",
    "--realm=localhost",
    "--use-auth-secret",
    `--static-auth-secret=${turnSecret}`,
    "--min-port=49160",
    "--max-port=49200",
    "--log-file=stdout"
  ],
  { stdio: "ignore" }
);
const child = spawn(process.execPath, ["scripts/voice-lab/run.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    TURN_REALM: "localhost",
    TURN_STATIC_AUTH_SECRET: turnSecret
  }
});
const cleanup = () => {
  child.kill();
  turn.kill();
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
child.on("exit", (code) => {
  turn.kill();
  process.exitCode = code ?? 1;
});
