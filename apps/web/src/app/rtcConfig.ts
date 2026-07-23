import type { RtcConfigResponse } from "../types.js";

export const rtcConfigRetryMs = 10_000;
const publicStunRtcConfig: RtcConfigResponse = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  expiresAt: null
};

export function rtcConfigAfterFetchFailure(current: RtcConfigResponse, hasSuccessfulConfig: boolean) {
  return hasSuccessfulConfig ? current : publicStunRtcConfig;
}
