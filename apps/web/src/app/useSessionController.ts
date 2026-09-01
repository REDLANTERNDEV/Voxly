import type { PublicUser } from "@voxly/shared";
import { useCallback,useEffect,useRef,useState } from "react";
import { ApiError,fetchConfig,fetchMe,fetchRtcConfig } from "../api.js";
import { createAuthRequestGate } from "../lib/authRequestGate.js";
import type { VoiceErrorKey } from "../lib/i18n.js";
import { getInviteTokenFromPath,resolveInitialRoute } from "../lib/navigation.js";
import type { AppConfigResponse,RtcConfigResponse } from "../types.js";
import { rtcConfigAfterFetchFailure,rtcConfigRetryMs } from "./rtcConfig.js";
import type { LoadState,Route } from "./types.js";

export function useSessionController(route: Route, navigate: (path: string) => void) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authState, setAuthState] = useState<LoadState>("loading");
  /** Empty unless the member was signed out for a reason they should be told. */
  const [signedOutReason, setSignedOutReason] = useState<"" | "reused" | "revoked">("");
  const [appConfig, setAppConfig] = useState<AppConfigResponse>({ publicUrl: null, turnstile: null, analytics: null });
  const [rtcConfig, setRtcConfig] = useState<RtcConfigResponse>({ iceServers: [], expiresAt: null });
  const [rtcConfigReady, setRtcConfigReady] = useState(false);
  const [rtcConfigError, setRtcConfigError] = useState<VoiceErrorKey | "">("");
  const authRequestGateRef = useRef(createAuthRequestGate());
  const authenticatedUserIdRef = useRef<string | null>(null);

  const completeAuthentication = useCallback((nextUser: PublicUser) => {
    authRequestGateRef.current.invalidate();
    if (authenticatedUserIdRef.current !== nextUser.id) setRtcConfigReady(false);
    authenticatedUserIdRef.current = nextUser.id;
    setUser(nextUser);
    setAuthState("ready");
  }, []);

  const clearAuthentication = useCallback(() => {
    authRequestGateRef.current.invalidate();
    authenticatedUserIdRef.current = null;
    setUser(null);
    setAuthState("ready");
  }, []);

  /**
   * Ask again whether this Device is still signed in.
   *
   * Called when the realtime connection drops, because a dropped socket is
   * usually the network but is also exactly what being signed out from another
   * Device looks like. Leaving somebody sitting in a room their account no
   * longer has any claim to — until they happen to refresh — is the worst
   * version of that, and one request settles it.
   *
   * A network failure answers nothing and changes nothing; only a 401 clears
   * the session, so a flaky connection cannot sign anybody out.
   */
  const checkStillSignedIn = useCallback(async () => {
    if (!authenticatedUserIdRef.current) return;
    try {
      await fetchMe();
    } catch (error: unknown) {
      if (!(error instanceof ApiError) || error.status !== 401) return;
      setSignedOutReason(error.code === "session_reused" ? "reused" : "revoked");
      clearAuthentication();
      navigate("/");
    }
  }, [clearAuthentication, navigate]);

  useEffect(() => {
    let mounted = true;
    fetchConfig().then((config) => { if (mounted) setAppConfig(config); })
      .catch(() => { if (mounted) setAppConfig({ publicUrl: null, turnstile: null, analytics: null }); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!user) {
      setRtcConfig({ iceServers: [], expiresAt: null });
      setRtcConfigError("");
      setRtcConfigReady(true);
      return;
    }
    setRtcConfigReady(false);
    setRtcConfig({ iceServers: [], expiresAt: null });
    setRtcConfigError("");
    let cancelled = false;
    let hasSuccessfulConfig = false;
    let refreshTimer: number | null = null;
    const load = async () => {
      try {
        const config = await fetchRtcConfig();
        if (cancelled) return;
        hasSuccessfulConfig = true;
        setRtcConfig(config);
        setRtcConfigError("");
        if (config.expiresAt) {
          const refreshInMs = Math.max(60_000, config.expiresAt * 1000 - Date.now() - 5 * 60_000);
          refreshTimer = window.setTimeout(() => void load(), refreshInMs);
        }
      } catch {
        if (!cancelled) {
          setRtcConfig((current) => rtcConfigAfterFetchFailure(current, hasSuccessfulConfig));
          setRtcConfigError("voiceError.rtcConfigUnavailable");
          refreshTimer = window.setTimeout(() => void load(), rtcConfigRetryMs);
        }
      } finally {
        if (!cancelled) setRtcConfigReady(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [user?.id]);

  useEffect(() => {
    let mounted = true;
    const generation = authRequestGateRef.current.begin();
    setAuthState("loading");
    fetchMe().then((response) => {
      if (!mounted || !authRequestGateRef.current.isCurrent(generation)) return;
      setRtcConfigReady(false);
      authenticatedUserIdRef.current = response.user.id;
      setUser(response.user);
      setAuthState("ready");
    }).catch((error: unknown) => {
      if (!mounted || !authRequestGateRef.current.isCurrent(generation)) return;
      if (error instanceof ApiError && error.status === 401) {
        authenticatedUserIdRef.current = null;
        setUser(null);
        // Being signed out because the session was seen in two places is not
        // the same as never having been signed in, and the member is owed the
        // difference (ADR-0015).
        setSignedOutReason(error.code === "session_reused" ? "reused" : "");
        setAuthState("ready");
        if (!new Set(["landing", "invite", "owner-claim", "access-claim", "link-device", "recover"]).has(route.name)) {
          navigate(resolveInitialRoute({ isAuthenticated: false, inviteToken: getInviteTokenFromPath(window.location.pathname) || null }));
        }
      } else setAuthState("error");
    });
    return () => { mounted = false; };
  }, []);

  return { user, authState, appConfig, rtcConfig, rtcConfigReady, rtcConfigError, signedOutReason, checkStillSignedIn, completeAuthentication, clearAuthentication };
}
