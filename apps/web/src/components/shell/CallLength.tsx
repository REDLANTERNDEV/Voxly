import { useEffect, useState } from "react";
import type { Translate } from "../../app/types.js";
import { callLengthMinutes, formatCallLength } from "../../lib/callLength.js";

/**
 * A running Call's length, beside its voice room's name in the rail. It ticks
 * on its own so a second passing re-renders this label and not the rail. The
 * digits are hidden from assistive technology, which would otherwise hear a new
 * name every second; the room link is named in whole minutes instead.
 */
export function CallLength({ startedAt, t }: { startedAt: number; t: Translate }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    let timer = 0;
    const scheduleNextSecond = () => {
      // Wake on the Call's next whole second rather than every 1000ms from
      // mount, so the label never lags its true value by most of a second.
      const elapsed = performance.now() - startedAt;
      timer = window.setTimeout(
        () => {
          setNow(performance.now());
          scheduleNextSecond();
        },
        1000 - (((elapsed % 1000) + 1000) % 1000)
      );
    };
    scheduleNextSecond();
    return () => window.clearTimeout(timer);
  }, [startedAt]);

  const elapsed = now - startedAt;
  const minutes = callLengthMinutes(elapsed);
  const spoken =
    minutes < 1
      ? t("voice.callUnderMinute")
      : minutes === 1
        ? t("voice.callOneMinute")
        : t("voice.callMinutes", { count: minutes });
  return (
    <>
      <span className="channel-call-length" aria-hidden="true">
        {formatCallLength(elapsed)}
      </span>
      <span className="sr-only">, {spoken}</span>
    </>
  );
}
