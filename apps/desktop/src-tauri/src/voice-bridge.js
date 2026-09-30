((origin, mode = "openMic") => {
  if (window !== window.top || window.location.origin !== origin) return;
  const receivers = { mute: null, deafen: null, microphone: null };
  const microphone = { mode, talkHeld: false, muteHeld: false };
  const microphoneState = () => ({ ...microphone });
  const notifyMicrophone = () => dispatch("microphone", microphoneState());
  const subscribe = (action, handler) => {
    if (typeof handler !== "function") return () => {};
    const lease = { handler };
    receivers[action] = lease;
    if (action === "microphone") handler(microphoneState());
    return () => { if (receivers[action] === lease) receivers[action] = null; };
  };
  const dispatch = (action, value) => {
    if (window !== window.top || window.location.origin !== origin) return;
    receivers[action]?.handler(value);
  };
  // This object has no IPC, file, registration, or other native operation.
  Object.defineProperty(window, "__VOXLY_DESKTOP_V1__", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: 1,
      subscribeMute(handler) {
        return subscribe("mute", handler);
      },
      dispatchMute() {
        dispatch("mute");
      },
      subscribeDeafen(handler) {
        return subscribe("deafen", handler);
      },
      dispatchDeafen() {
        dispatch("deafen");
      },
      getMicrophoneState() { return microphoneState(); },
      subscribeMicrophone(handler) { return subscribe("microphone", handler); },
      dispatchMicrophoneMode(next) {
        if (window !== window.top || window.location.origin !== origin) return;
        if (!["openMic", "pushToTalk", "pushToMute"].includes(next)) return;
        microphone.mode = next;
        microphone.talkHeld = false;
        microphone.muteHeld = false;
        notifyMicrophone();
      },
      dispatchPushToTalk(pressed) {
        if (window !== window.top || window.location.origin !== origin) return;
        if (typeof pressed !== "boolean") return;
        microphone.talkHeld = pressed;
        notifyMicrophone();
      },
      dispatchPushToMute(pressed) {
        if (window !== window.top || window.location.origin !== origin) return;
        if (typeof pressed !== "boolean") return;
        microphone.muteHeld = pressed;
        notifyMicrophone();
      }
    })
  });
})
