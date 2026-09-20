export type TimeFormatPreference = "auto" | "12" | "24";

export const timeFormatStorageKey = "voxly:time-format:v1";

const preferences = new Set<TimeFormatPreference>(["auto", "12", "24"]);
type HourCycle = NonNullable<Intl.DateTimeFormatOptions["hourCycle"]>;

function deviceHourCycle(): HourCycle {
  const resolved = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
  if (resolved.hourCycle === "h11" || resolved.hourCycle === "h12" || resolved.hourCycle === "h23" || resolved.hourCycle === "h24") {
    return resolved.hourCycle;
  }
  return resolved.hour12 ? "h12" : "h23";
}

export function readTimeFormatPreference(storage: Pick<Storage, "getItem">): TimeFormatPreference {
  const stored = storage.getItem(timeFormatStorageKey);
  return stored && preferences.has(stored as TimeFormatPreference)
    ? stored as TimeFormatPreference
    : "auto";
}

export function saveTimeFormatPreference(
  storage: Pick<Storage, "setItem">,
  preference: TimeFormatPreference
) {
  storage.setItem(timeFormatStorageKey, preference);
}

export function timeFormatOptions(
  preference: TimeFormatPreference,
  automaticHourCycle: HourCycle = deviceHourCycle()
): Pick<Intl.DateTimeFormatOptions, "hourCycle"> {
  if (preference === "12") return { hourCycle: "h12" };
  if (preference === "24") return { hourCycle: "h23" };
  return { hourCycle: automaticHourCycle };
}
