import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { requestLogOptions } from "../src/app.js";

/**
 * An invite link carries its bearer token in the path, and the request log is
 * on by default. Raw tokens are never logged (`AGENTS.md`, Security Rules).
 */
describe("the request log", () => {
  it("never writes an invite token from the URL path", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      }
    });
    const server = Fastify({ logger: { ...requestLogOptions, stream } });
    server.get("/*", async () => "spa");
    await server.inject({ method: "GET", url: "/invite/raw-invite-token-value?ref=1" });
    await server.close();

    const logged = lines.join("");
    assert.match(logged, /"url":"\/invite\/<redacted>"/);
    assert.doesNotMatch(logged, /raw-invite-token-value/);
  });

  it("leaves other paths readable for the operator", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      }
    });
    const server = Fastify({ logger: { ...requestLogOptions, stream } });
    server.get("/api/health", async () => ({ status: "ok" }));
    await server.inject({ method: "GET", url: "/api/health" });
    await server.close();

    assert.match(lines.join(""), /"url":"\/api\/health"/);
  });

  it("is the logger configuration the application starts with", () => {
    const source = readFileSync("src/app.ts", "utf8");
    assert.match(source, /logger:\s+options\.logger\s+\?\s+requestLogOptions\s+:\s+false/);
  });
});
