import { createOwnerClaim, OwnerSetupError } from "../auth/ownerClaims.js";

const args = parseArgs(process.argv.slice(2));
const nickname = args.nickname;

if (!nickname) {
  console.error("Missing required --nickname value.");
  process.exit(1);
}

const databasePath = args.database ?? process.env.DATABASE_PATH ?? "./voxly.sqlite";
const baseUrl = args["base-url"] ?? process.env.VOXLY_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const expiresInMinutes = args["expires-in-minutes"] ? Number(args["expires-in-minutes"]) : undefined;

try {
  const claim = await createOwnerClaim({
    databasePath,
    nickname,
    baseUrl,
    expiresInMinutes
  });

  console.log("Owner created.");
  console.log(`Claim URL: ${claim.url}`);
  console.log(`Expires at: ${claim.expiresAt}`);
} catch (error) {
  if (error instanceof OwnerSetupError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

function parseArgs(values: string[]) {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }

    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }

    result[key] = next;
    index += 1;
  }
  return result;
}
