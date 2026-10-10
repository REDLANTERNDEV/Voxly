import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { sessionDiagnostics } from "../auth/sessionDiagnostics.js";

try {
  const { values } = parseArgs({ options: { database: { type: "string" }, "account-id": { type: "string" } } });
  if (!values.database || !values["account-id"]) {
    throw new Error("Usage: sessions:diagnose -- --database PATH --account-id ACCOUNT_ID");
  }
  // Do not use openDatabase: its startup migrations would change the evidence.
  const sqlite = new DatabaseSync(values.database, { readOnly: true });
  try {
    console.log(JSON.stringify(sessionDiagnostics(sqlite, values["account-id"]), null, 2));
  } finally {
    sqlite.close();
  }
} catch {
  console.error(
    "Session diagnosis failed. Supply an existing readable database and an Account id with --database and --account-id."
  );
  process.exitCode = 1;
}
