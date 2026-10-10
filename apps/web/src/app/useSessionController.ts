import type { PublicUser } from "@voxly/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchConfig, fetchMe, fetchRtcConfig } from "../api.js";
import { createAuthRequestGate } from "../lib/authRequestGate.js";
import { checkSessionAfterDisconnect } from "../lib/sessionCheck.js";
import type { VoiceErrorKey } from "../lib/i18n.js";
import { getInviteTokenFromPath, resolveInitialRoute } from "../lib/navigation.js";
import type { AppConfigResponse, RtcConfigResponse } from "../types.js";
import { rtcConfigAfterFetchFailure, rtcConfigRetryMs } from "./rtcConfig.js";
import type { LoadState, Route } from "./types.js";

export function useSessionController(route: Route, navigate: (path: string) => void) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authState, setAuthState] = useState<LoadState>("loading");
  /** Empty unless the member was signed out for a reason they should be told. */
  const [signedOutReason, setSignedOutReason] = useState<
    "" | "reused" | "revoked" | "request_approved" | "owner_initiated"
  >("");
  const [appConfig, setAppConfig] = useState<AppConfigResponse>({
    clientVersion: null,
    publicUrl: null,
    turnstile: null,
    analytics: null
  });
  const [rtcConfig, setRtcConfig] = useState<RtcConfigResponse>({ iceServers: [], expiresAt: null });
  const [rtcConfigReady, setRtcConfigReady] = useState(false);
  const [rtcConfigError, setRtcConfigError] = useState<VoiceErrorKey | "">("");
  const [rtcConfigErrorRevision, setRtcConfigErrorRevision] = useState(0);
  const authRequestGateRef = useRef(createAuthRequestGate());
  const authenticatedUserIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  const completeAuthentication = useCallback((nextUser: PublicUser) => {
    authRequestGateRef.current.invalidate();
    if (authenticatedUserIdRef.current !== nextUser.id) setRtcConfigReady(false);
    authenticatedUserIdRef.current = nextUser.id;
    setUser(nextUser);
    setAuthState("ready");
    setSignedOutReason("");
  }, []);

  const clearAuthentication = useCallback(() => {
    authRequestGateRef.current.invalidate();
    authenticatedUserIdRef.current = null;
    setUser(null);
    setAuthState("ready");
  }, []);

  const finishDeletedAccount = useCallback(
    (reason: "request_approved" | "owner_initiated") => {
      setSignedOutReason(reason);
      clearAuthentication();
      navigate("/");
    },
    [clearAuthentication, navigate]
  );

  /**
   * Ask again whether this Device is still signed in.
   *
   * Called when the realtime connection drops, because a dropped socket is
   * usually the network but is also exactly what being signed out from another
   * Device looks like. Leaving somebody sitting in a room their account no
   * longer has any claim to — until they happen to refresh — is the worst
   * version of that.
   *
   * Confirm a 401 with a fresh lookup. A network failure answers nothing;
   * a newer authentication or check invalidates every older outcome.
   */
  const checkStillSignedIn = useCallback(async () => {
    if (!mountedRef.current || !authenticatedUserIdRef.current) return;
    await checkSessionAfterDisconnect({
      gate: authRequestGateRef.current,
      lookup: fetchMe,
      isUnauthorized: (error) => error instanceof ApiError && error.status === 401,
      signedOut: (error) => {
        setSignedOutReason(error instanceof ApiError && error.code === "session_reused" ? "reused" : "revoked");
        clearAuthentication();
        navigate("/");
      }
    });
  }, [clearAuthentication, navigate]);

  useEffect(() => {
    let mounted = true;
    mountedRef.current = true;
    const gate = authRequestGateRef.current;
    fetchConfig()
      .then((config) => {
        if (mounted) setAppConfig(config);
      })
      .catch(() => {
        if (mounted) setAppConfig({ clientVersion: null, publicUrl: null, turnstile: null, analytics: null });
      });
    return () => {
      mounted = false;
      mountedRef.current = false;
      gate.invalidate();
    };
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
          setRtcConfigErrorRevision((current) => current + 1);
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
    fetchMe()
      .then((response) => {
        if (!mounted || !authRequestGateRef.current.isCurrent(generation)) return;
        setRtcConfigReady(false);
        authenticatedUserIdRef.current = response.user.id;
        setUser(response.user);
        setAuthState("ready");
      })
      .catch((error: unknown) => {
        if (!mounted || !authRequestGateRef.current.isCurrent(generation)) return;
        if (error instanceof ApiError && error.status === 401) {
          authenticatedUserIdRef.current = null;
          setUser(null);
          // A rejected old credential needs recovery guidance, not attribution
          // to another Device; delayed requests also produce this result.
          setSignedOutReason(error.code === "session_reused" ? "reused" : "");
          setAuthState("ready");
          if (
            !new Set([
              "landing",
              "invite",
              "owner-claim",
              "access-claim",
              "link-device",
              "desktop-verify",
              "recover"
            ]).has(route.name)
          ) {
            navigate(
              resolveInitialRoute({
                isAuthenticated: false,
                inviteToken: getInviteTokenFromPath(window.location.pathname) || null
              })
            );
          }
        } else setAuthState("error");
      });
    return () => {
      mounted = false;
    };
  }, []);

  return {
    user,
    authState,
    appConfig,
    rtcConfig,
    rtcConfigReady,
    rtcConfigError,
    rtcConfigErrorRevision,
    signedOutReason,
    checkStillSignedIn,
    completeAuthentication,
    clearAuthentication,
    finishDeletedAccount
  };
}
