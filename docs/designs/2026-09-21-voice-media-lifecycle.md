# Voice media lifetime and startup diagnosis

The reported symptoms are distinct until evidence connects them:

- Some first joins produce robot-like microphone audio within approximately
  fifteen seconds. Leaving and rejoining, often by the affected speaker, clears
  it for hours. This symptom has not been reproduced in a real browser here.
- A reload can leave a Listener unable to hear the Music bot, while explicitly
  leaving and rejoining restores it. This was reproduced with real local WebRTC
  connections in both offer directions.

## Confirmed defect and change

Room membership survives a short disconnect, but a reload destroys the
browser's media runtime. Both the browser and bot used account identity alone
when deciding whether to reuse a peer connection. The remaining peer therefore
kept a transport whose remote endpoint no longer existed. An ICE restart is not
an explicit replacement of that endpoint's entire media runtime.

`VoiceJoinRequest.mediaInstanceId` identifies one live media runtime. It is a
public random identifier, not an authentication token, and is never persisted.
A browser retains it through a short signalling-only reconnect. Reload, leave,
or disposal of all peer connections requires a new identifier. Legacy clients
receive a server-generated public identifier per socket. The server includes it
in the member state and stamps forwarded signals with the current sender's
identifier; a replaced socket cannot forward signals as the new instance.

A changed identifier in the authoritative snapshot replaces that member's
connection in the browser and the bot without changing membership, firing
arrival/departure cues, or losing the Music bot's Queue. Signals from a known
older instance are ignored. Pending asynchronous operations and transport
events must not mutate a replacement connection.

Initial browser negotiation is tracked by whether the connection actually
sent an offer or answered one, not merely whether a connection object exists.
An early candidate may have created that object before the roster arrived.
Repeated snapshots must not create duplicate offers.

No database migration, new service, TURN change, codec tuning, microphone
processing change, or automatic full-room reset is part of this change.

## Capturing the unresolved robot-like audio

During a call, the download button beside the voice quality indicator exports a
JSON report. It contains measurements, not audio. There is no automatic upload
or browser-storage persistence. Logging out clears it; reloading the page also
clears it. Leaving and rejoining retains the previous measurements so the two
states can be compared.

The recorder retains the last three calls. Each keeps at most 200 measurements
from its first minute and 300 later measurements, so hours of successful audio
cannot erase the startup window or grow memory without bound. Peer connections
have local numeric aliases; the report contains no account/room/device names,
SDP, ICE credentials, addresses, cookies, authentication tokens or audio samples.

The existing four-second sampler records allowlisted audio RTP counters, media
source energy, transport state, microphone processing-context state, input RMS,
optional suppression/worklet state, and native output playback state. Only one
sampling pass runs at once. These measurements do not prove that a human hears
undistorted audio, and a four-second sample can miss brief disturbances.

For an incident, download on the affected sender and receiver before reload,
then leave/rejoin and download again. Note which direction sounded broken and
approximately when it recovered. Compare:

1. Capture RMS and context/track state against outbound source energy.
2. Outbound activity against received RTP, loss, concealment and buffer changes.
3. Received activity against paused, muted or blocked output state.
4. Connection replacement and recovery timing against the symptom.

This evidence is required before attributing startup robotisation to the
microphone graph, browser playback, network route, or recovery behaviour. The
reload regression is not proof that the initial-join symptom is fixed.

## Validation and rollout

The bot regression tests first establish actual RTP reception, replace the
Listener with the same account and a new media identifier without an intervening
departure, and require resumed RTP reception. Both offer directions failed
before the change and passed afterwards. Additional server tests cover retained
instances during signalling reconnect, changed instances on reload, and stale
sender rejection; browser callback tests cover replacement and initial offers.

Deploy the server, web client and Music bot together. The new wire fields are
optional for compatibility, but an older receiver cannot implement the new
replacement behaviour. Refresh browser clients after deploying. These tests
use local WebRTC without Coturn; production TURN routes and the reported
first-join audio distortion still need validation on the affected devices.
