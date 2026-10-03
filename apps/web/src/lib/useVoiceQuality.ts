import { useEffect, useState } from "react";
import { measuringVoiceQuality, VoiceQualityController, type VoiceStatsSource } from "./voiceQualityController.js";
export type { VoiceQuality, VoiceQualityRecoveryRequest, VoiceStatsPeer, VoiceStatsSource } from "./voiceQualityController.js";

// Recovery still requires two four-second observations, not two render ticks.
export const voiceQualitySampleMs = 4_000;

/** React owns only subscription lifetime; the controller owns measurement state. */
export function useVoiceQuality(peers: VoiceStatsSource | null) {
  const [quality, setQuality] = useState(measuringVoiceQuality);
  useEffect(() => {
    setQuality(measuringVoiceQuality());
    if (!peers) return;
    const controller = new VoiceQualityController(peers);
    let disposed = false;
    const sample = async () => {
      const next = await controller.sample();
      if (!disposed && next) setQuality(next);
    };
    void sample();
    const timer = window.setInterval(() => void sample(), voiceQualitySampleMs);
    return () => {
      disposed = true;
      controller.dispose();
      window.clearInterval(timer);
    };
  }, [peers]);
  return quality;
}
