import type { CallState } from "./transitions.js";

export interface UpdateSnapshot {
  currentVersion: string;
  phase: "disabled" | "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";
  version: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
}

/** Consent always follows verification, immediately before media teardown. */
export async function installVerifiedUpdate(options: {
  report: () => Promise<CallState | null>;
  confirm: (report: CallState | null) => Promise<boolean>;
  stop: () => void;
  install: () => Promise<void>;
}): Promise<boolean> {
  const report = await options.report().catch(() => null);
  if (!(await options.confirm(report))) return false;
  options.stop();
  await options.install();
  return true;
}
