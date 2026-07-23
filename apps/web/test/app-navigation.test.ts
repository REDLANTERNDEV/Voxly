import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyThemeChoice, parseRoute, readThemeChoice, saveThemeChoice, serverPath } from "../src/app/navigation.js";

describe("application navigation helpers", () => {
  it("preserves the owner claim token from the URL fragment", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { hash: "#claim=owner%20token" } }
    });

    try {
      assert.deepEqual(parseRoute("/setup/owner"), { name: "owner-claim", token: "owner token" });
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("encodes dynamic route segments", () => {
    assert.equal(serverPath("server/name", "text", "room name"), "/app/server/server%2Fname/text/room%20name");
  });
});

describe("application theme persistence", () => {
  it("removes the stored override when returning to auto", () => {
    const calls: string[] = [];
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => "dark",
          removeItem: (key: string) => calls.push(`remove:${key}`),
          setItem: (key: string, value: string) => calls.push(`set:${key}:${value}`)
        }
      }
    });

    try {
      assert.equal(readThemeChoice(), "dark");
      saveThemeChoice("auto");
      assert.deepEqual(calls, ["remove:voxly:theme"]);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("applies and clears the document theme attribute", () => {
    const calls: string[] = [];
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: {
          removeAttribute: (name: string) => calls.push(`remove:${name}`),
          setAttribute: (name: string, value: string) => calls.push(`set:${name}:${value}`)
        }
      }
    });

    try {
      applyThemeChoice("auto");
      applyThemeChoice("light");
      assert.deepEqual(calls, ["remove:data-theme", "set:data-theme:light"]);
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});
