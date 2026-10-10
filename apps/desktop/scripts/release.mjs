import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(resolve(workspace, path), "utf8"));

function https(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Release URLs must be credential-free HTTPS URLs");
  return url;
}

function publicKey(value) {
  const lines = Buffer.from(value, "base64").toString("utf8").trim().split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment:"))
    throw new Error("Expected the content of a Tauri public-key file");
  const key = Buffer.from(lines[1], "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed") throw new Error("Invalid updater public key");
  return key;
}

/** Minisign envelopes use Ed25519; hashing and verification use Node's crypto API. */
export function verifyArtifact(bytes, encodedSignature, encodedKey) {
  const key = publicKey(encodedKey);
  const lines = Buffer.from(encodedSignature.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith("trusted comment: "))
    throw new Error("Invalid updater signature");
  const signature = Buffer.from(lines[1], "base64");
  if (signature.length !== 74 || !key.subarray(2, 10).equals(signature.subarray(2, 10)))
    throw new Error("Wrong updater signing key");
  const algorithm = signature.subarray(0, 2).toString();
  if (!["ED", "Ed"].includes(algorithm)) throw new Error("Unsupported updater signature");
  const data = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  const ed25519 = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki"
  });
  const signed = signature.subarray(10);
  const trustedComment = Buffer.from(lines[2].slice("trusted comment: ".length));
  if (
    !verifySignature(null, data, ed25519, signed) ||
    !verifySignature(null, Buffer.concat([signed, trustedComment]), ed25519, Buffer.from(lines[3], "base64"))
  )
    throw new Error("Updater signature verification failed");
}

export function releaseConfig(env, versions) {
  const endpoint = https(env.VOXLY_DESKTOP_UPDATE_ENDPOINT).href;
  const key = env.VOXLY_DESKTOP_UPDATER_PUBLIC_KEY;
  publicKey(key);
  const version = env.VOXLY_DESKTOP_RELEASE_VERSION;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !versions.every((actual) => actual === version))
    throw new Error("Release version must match desktop package, Cargo and Tauri versions");
  const signing = env.VOXLY_DESKTOP_WINDOWS_SIGNING ?? "authenticode";
  if (!["none", "authenticode"].includes(signing)) throw new Error("Windows signing must be none or authenticode");
  const publisher = env.VOXLY_DESKTOP_PUBLISHER?.trim();
  if (!publisher || publisher.length > 100 || (signing === "authenticode" && publisher.toLowerCase() === "voxly"))
    throw new Error("Set the distributor publisher name");
  const windows = { webviewInstallMode: { type: "offlineInstaller" } };
  if (signing === "authenticode") {
    const thumbprint = env.VOXLY_DESKTOP_CERTIFICATE_THUMBPRINT;
    if (!/^[0-9a-f]{40}$/i.test(thumbprint ?? "")) throw new Error("A Windows Authenticode certificate is required");
    Object.assign(windows, {
      certificateThumbprint: thumbprint,
      digestAlgorithm: "sha256",
      timestampUrl: https(env.VOXLY_DESKTOP_TIMESTAMP_URL).href,
      tsp: true
    });
  }
  return {
    plugins: { updater: { endpoints: [endpoint], pubkey: key, windows: { installMode: "passive" } } },
    bundle: { publisher, createUpdaterArtifacts: true, windows }
  };
}

function run() {
  const env = process.env;
  if (process.argv[2] === "prepare") {
    const cargo = readFileSync(resolve(workspace, "src-tauri/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1];
    const config = releaseConfig(env, [
      readJson("package.json").version,
      readJson("src-tauri/tauri.conf.json").version,
      cargo
    ]);
    writeFileSync(env.VOXLY_DESKTOP_RELEASE_CONFIG, JSON.stringify(config, null, 2) + "\n");
  } else if (process.argv[2] === "finalize") {
    const bundle = resolve(workspace, "src-tauri/target/release/bundle/nsis");
    const installers = readdirSync(bundle).filter((name) => name.endsWith("-setup.exe"));
    if (installers.length !== 1) throw new Error("Expected exactly one fresh NSIS installer");
    const name = installers[0];
    const installer = readFileSync(resolve(bundle, name));
    const signature = readFileSync(resolve(bundle, `${name}.sig`), "utf8").trim();
    verifyArtifact(installer, signature, env.VOXLY_DESKTOP_UPDATER_PUBLIC_KEY);
    const base = https(env.VOXLY_DESKTOP_RELEASE_BASE_URL);
    if (!base.pathname.endsWith("/") || base.search)
      throw new Error("Artifact base URL must end with / and have no query");
    const output = resolve(env.VOXLY_DESKTOP_RELEASE_OUTPUT);
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, name), installer);
    writeFileSync(resolve(output, `${name}.sig`), signature + "\n");
    const config = JSON.parse(readFileSync(env.VOXLY_DESKTOP_RELEASE_CONFIG, "utf8"));
    writeFileSync(
      resolve(output, "latest.json"),
      JSON.stringify(
        {
          version: env.VOXLY_DESKTOP_RELEASE_VERSION,
          platforms: { "windows-x86_64": { url: new URL(encodeURIComponent(name), base).href, signature } }
        },
        null,
        2
      ) + "\n"
    );
    writeFileSync(
      resolve(output, "provenance.json"),
      JSON.stringify(
        {
          version: env.VOXLY_DESKTOP_RELEASE_VERSION,
          commit: env.GITHUB_SHA,
          repository: env.GITHUB_REPOSITORY,
          run: env.GITHUB_RUN_ID,
          target: "x86_64-pc-windows-msvc",
          updaterEndpoint: config.plugins.updater.endpoints[0],
          updaterKeySha256: createHash("sha256").update(env.VOXLY_DESKTOP_UPDATER_PUBLIC_KEY).digest("hex"),
          windowsSigning: config.bundle.windows.certificateThumbprint ? "authenticode" : "none",
          authenticodeThumbprint: config.bundle.windows.certificateThumbprint ?? null
        },
        null,
        2
      ) + "\n"
    );
    const checksums = readdirSync(output)
      .sort()
      .map(
        (file) =>
          `${createHash("sha256")
            .update(readFileSync(resolve(output, file)))
            .digest("hex")}  ${basename(file)}`
      )
      .join("\n");
    writeFileSync(resolve(output, "SHA256SUMS"), checksums + "\n");
  } else throw new Error("Use prepare or finalize");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
