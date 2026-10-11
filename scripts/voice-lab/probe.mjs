// Injected only by the lab into its disposable, fixture-only browser contexts.
// It is never bundled into Voxly or installed in a member's browser.
export function installProbe({ relay = false, bufferTarget = null, synchronizedFixture = null } = {}) {
  const peers = new Set();
  const captures = new Set();
  const peerAliases = new WeakMap();
  const streamAliases = new WeakMap();
  let peerSequence = 0;
  const recoveryDecisions = [];
  const fixtureSources = new Set();
  let fixtureStartAt = null;
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const raw = await nativeCapture(...args);
    let stream = raw;
    if (synchronizedFixture) {
      // Transport-only fixture: retain capture ownership/permission, but bypass
      // the device's DSP equally for Voxly and native. Default runs use raw capture.
      const context = new AudioContext({ sampleRate: 48000 });
      const destination = context.createMediaStreamDestination();
      const buffer = context.createBuffer(1, synchronizedFixture.length, 48000);
      buffer.copyToChannel(Float32Array.from(synchronizedFixture), 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(destination);
      source.start();
      const fixture = { context, destination, buffer, source };
      fixtureSources.add(fixture);
      await context.resume();
      stream = destination.stream;
      const track = stream.getAudioTracks()[0],
        stop = track.stop.bind(track);
      track.stop = () => {
        if (!fixtureSources.delete(fixture)) return;
        fixture.source?.stop();
        fixture.source?.disconnect();
        raw.getTracks().forEach((rawTrack) => rawTrack.stop());
        stop();
        void context.close();
      };
    }
    captures.add(stream);
    return stream;
  };
  // Synthetic screen media exercises Voxly's real publication/subscription path.
  // It does not certify the operating system's screen picker or loopback capture.
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const paint = () => {
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#248";
      ctx.fillRect(0, 0, 320, 180);
    };
    paint();
    const timer = setInterval(paint, 100);
    const stream = canvas.captureStream(10);
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0.03;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    const video = stream.getVideoTracks()[0],
      stop = video.stop.bind(video);
    video.stop = () => {
      clearInterval(timer);
      destination.stream.getTracks().forEach((track) => track.stop());
      oscillator.stop();
      void context.close();
      stop();
    };
    await context.resume();
    return stream;
  };
  const Peer = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Peer, {
    construct(Target, [config = {}, ...rest]) {
      const peer = new Target({ ...config, ...(relay ? { iceTransportPolicy: "relay" } : {}) }, ...rest);
      peers.add(peer);
      peerAliases.set(peer, ++peerSequence);
      streamAliases.set(peer, new Map());
      peer.addEventListener("track", ({ receiver }) => {
        if (receiver.track.kind === "audio" && bufferTarget !== null && "jitterBufferTarget" in receiver)
          receiver.jitterBufferTarget = bufferTarget;
      });
      return peer;
    }
  });
  const livePeers = () => [...peers].filter((peer) => peer.connectionState !== "closed");
  const liveCaptures = () =>
    [...captures].filter((stream) => stream.getAudioTracks().some((track) => track.readyState === "live"));
  const outputElements = () =>
    [...document.querySelectorAll("audio")].filter((element) => element.srcObject instanceof MediaStream);
  const stats = async () =>
    Promise.all(
      livePeers().map(async (peer) => {
        const entries = [...(await peer.getStats()).values()];
        const pairId = entries.find((entry) => entry.type === "transport")?.selectedCandidatePairId;
        const pair = entries.find((entry) => entry.id === pairId);
        const candidate = entries.find((entry) => entry.id === pair?.localCandidateId);
        const remote = entries.find((entry) => entry.id === pair?.remoteCandidateId);
        const aliases = streamAliases.get(peer);
        const alias = (entry) => {
          const key = JSON.stringify([entry.id, entry.ssrc, entry.trackIdentifier]);
          if (!aliases.has(key)) aliases.set(key, aliases.size + 1);
          return aliases.get(key);
        };
        const relayed = candidate?.candidateType === "relay" || remote?.candidateType === "relay";
        const address = candidate?.address ?? candidate?.ip;
        return {
          mediaProtocol: relayed ? (candidate?.relayProtocol ?? "unknown") : (candidate?.protocol ?? "unknown"),
          networkFamily:
            typeof address === "string" && address.includes(":")
              ? "ipv6"
              : typeof address === "string" && /^[0-9.]+$/.test(address)
                ? "ipv4"
                : "unknown",
          peerAlias: peerAliases.get(peer),
          connection: peer.connectionState,
          route:
            candidate?.candidateType === "relay" || remote?.candidateType === "relay"
              ? "relay"
              : pair
                ? "direct"
                : "unknown",
          bufferTargetSupported: peer.getReceivers().some((receiver) => "jitterBufferTarget" in receiver),
          outboundAudio: entries
            .filter((entry) => entry.type === "outbound-rtp" && entry.kind === "audio")
            .map((entry) => ({
              packetsSent: entry.packetsSent,
              bytesSent: entry.bytesSent,
              totalSamplesSent: entry.totalSamplesSent,
              framesEncoded: entry.framesEncoded
            })),
          audio: entries
            .filter((entry) => entry.type === "inbound-rtp" && entry.kind === "audio")
            .map((entry) => ({
              streamAlias: alias(entry),
              totalAudioEnergy: entry.totalAudioEnergy,
              packetsReceived: entry.packetsReceived,
              packetsLost: entry.packetsLost,
              concealedSamples: entry.concealedSamples,
              silentConcealedSamples: entry.silentConcealedSamples,
              removedSamplesForAcceleration: entry.removedSamplesForAcceleration,
              insertedSamplesForDeceleration: entry.insertedSamplesForDeceleration,
              jitterBufferDelay: entry.jitterBufferDelay,
              jitterBufferEmittedCount: entry.jitterBufferEmittedCount,
              jitterBufferTargetDelay: entry.jitterBufferTargetDelay,
              jitterBufferMinimumDelay: entry.jitterBufferMinimumDelay
            }))
        };
      })
    );
  async function record(seconds = 6, startAt = Date.now() + 1500) {
    if (seconds < 0.1 || seconds > 30) throw new Error("Fixture recording must be bounded to 30 seconds");
    const context = new AudioContext({ sampleRate: 48000 });
    const module = URL.createObjectURL(
      new Blob(
        [
          `
      class Probe extends AudioWorkletProcessor {
        constructor({ processorOptions: { startFrame, frames } }) {
          super(); this.start = startFrame; this.end = startFrame + frames;
          this.data = new Float32Array(4800); this.offset = 0; this.chunkStart = 0;
        }
        process(inputs, outputs) {
          const input = inputs[0]?.[0];
          const frames = outputs[0][0].length;
          for (let i = 0; i < frames; i++) {
            const frame = currentFrame + i;
            if (frame < this.start || frame >= this.end) continue;
            if (!this.offset) this.chunkStart = frame - this.start;
            this.data[this.offset++] = input?.[i] ?? 0;
            if (this.offset === this.data.length || frame + 1 === this.end) {
              this.port.postMessage({ offset: this.chunkStart, samples: this.data.slice(0, this.offset) });
              this.offset = 0;
            }
          }
          return true;
        }
      }
      registerProcessor('voice-lab-probe', Probe);
    `
        ],
        { type: "text/javascript" }
      )
    );
    const stages = new Map();
    const bindings = new Map();
    const timeline = [];
    const snapshots = [];
    let poll;
    let statsPoll;
    let pendingStats = null;
    try {
      await context.audioWorklet.addModule(module);
      await context.resume();
      if (Date.now() >= startAt - 100) throw new Error("Recorder missed its scheduled start");
      const startFrame = Math.round((context.currentTime + (startAt - Date.now()) / 1000) * context.sampleRate);
      for (const stage of ["capture", "published", "received"]) {
        const bus = context.createGain();
        const node = new AudioWorkletNode(context, "voice-lab-probe", {
          processorOptions: { startFrame, frames: Math.round(seconds * context.sampleRate) }
        });
        const silent = context.createGain();
        silent.gain.value = 0;
        const samples = new Float32Array(Math.round(seconds * context.sampleRate));
        const recording = { stage, samples, recordedSamples: 0 };
        node.port.onmessage = ({ data }) => {
          samples.set(data.samples, data.offset);
          recording.recordedSamples += data.samples.length;
        };
        bus.connect(node).connect(silent).connect(context.destination);
        stages.set(stage, { bus, node, silent, recording });
        bindings.set(stage, new Map());
      }
      const refresh = () => {
        const inputs = {
          capture: liveCaptures().flatMap((stream) =>
            stream.getAudioTracks().map((track) => ({ key: track, track, volume: 1 }))
          ),
          published: [...new Set(livePeers().flatMap((peer) => peer.getSenders().map((sender) => sender.track)))]
            .filter((track) => track?.kind === "audio" && track.readyState === "live")
            .map((track) => ({ key: track, track, volume: 1 })),
          received: outputElements().flatMap((element) =>
            element.srcObject
              .getAudioTracks()
              .filter((track) => track.readyState === "live")
              .map((track) => ({ key: element, track, volume: element.paused || element.muted ? 0 : element.volume }))
          )
        };
        let changed = false;
        for (const [stage, map] of bindings) {
          const live = new Map(inputs[stage].map((input) => [input.key, input]));
          for (const [key, binding] of map) {
            if (live.get(key)?.track === binding.track) continue;
            binding.source.disconnect();
            binding.gain.disconnect();
            map.delete(key);
            changed = true;
          }
          for (const { key, track, volume } of live.values()) {
            if (!map.has(key)) {
              const source = context.createMediaStreamSource(new MediaStream([track]));
              const gain = context.createGain();
              source.connect(gain).connect(stages.get(stage).bus);
              map.set(key, { source, gain, track });
              changed = true;
            }
            map.get(key).gain.gain.value = volume;
          }
        }
        if (changed && timeline.length < 200)
          timeline.push({
            atMs: Date.now() - startAt,
            captures: bindings.get("capture").size,
            published: bindings.get("published").size,
            received: bindings.get("received").size
          });
      };
      const sample = async () => {
        const peers = await stats();
        snapshots.push({ atMs: Date.now() - startAt, peers });
      };
      refresh();
      poll = setInterval(refresh, 20);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));
      await sample();
      statsPoll = setInterval(() => {
        if (pendingStats) return;
        pendingStats = sample()
          .catch(() => {
            snapshots.push({ atMs: Date.now() - startAt, peers: [], error: "stats-unavailable" });
          })
          .finally(() => {
            pendingStats = null;
          });
      }, 500);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt + seconds * 1000 + 150 - Date.now())));
      clearInterval(statsPoll);
      if (pendingStats) await pendingStats;
      await sample();
      return {
        startedAt: startAt,
        fixtureStartAt,
        statsBefore: snapshots[0].peers,
        stats: snapshots.at(-1).peers,
        statsTimeline: snapshots,
        bindingTimeline: timeline,
        recoveryDecisions: recoveryDecisions
          .filter((decision) => decision.at >= startAt && decision.at <= startAt + seconds * 1000)
          .map(({ at, ...decision }) => ({ atMs: at - startAt, ...decision })),
        sampleRate: context.sampleRate,
        recordings: [...stages.values()].map(({ recording }) => ({
          ...recording,
          samples: Array.from(recording.samples)
        })),
        output: outputElements().map((element) => ({
          paused: element.paused,
          muted: element.muted,
          volume: element.volume,
          readyState: element.readyState
        }))
      };
    } finally {
      clearInterval(poll);
      clearInterval(statsPoll);
      if (pendingStats) await pendingStats.catch(() => {});
      for (const map of bindings.values())
        for (const { source, gain } of map.values()) {
          source.disconnect();
          gain.disconnect();
        }
      for (const { bus, node, silent } of stages.values()) {
        bus.disconnect();
        node.disconnect();
        node.port.close();
        silent.disconnect();
      }
      await context.close();
      URL.revokeObjectURL(module);
    }
  }
  let reference = null;
  window.voiceLab = {
    record,
    stats,
    recoveryDecision(peer, { stalled, eligible, recover, expectingAudio }) {
      recoveryDecisions.push({
        at: Date.now(),
        peerAlias: peerAliases.get(peer),
        stalled,
        eligible,
        recover,
        expectingAudio
      });
      if (recoveryDecisions.length > 1000) recoveryDecisions.shift();
    },
    armFixture(startAt) {
      if (!fixtureSources.size) throw new Error("No synchronized capture to schedule");
      fixtureStartAt = startAt;
      for (const fixture of fixtureSources) {
        fixture.source?.stop();
        fixture.source?.disconnect();
        const source = fixture.context.createBufferSource();
        source.buffer = fixture.buffer;
        source.loop = true;
        source.connect(fixture.destination);
        source.start(fixture.context.currentTime + Math.max(0, startAt - Date.now()) / 1000);
        fixture.source = source;
      }
    },
    async dropPublishedAudio() {
      const peer = livePeers()[0];
      if (!peer) throw new Error("No live peer to stall");
      const sender = peer.getSenders().find((sender) => sender.track?.kind === "audio");
      if (!sender) throw new Error("No published audio sender to stall");
      await sender.replaceTrack(null);
      return peerAliases.get(peer);
    },
    state: () => ({
      captures: liveCaptures().length,
      peers: livePeers().length,
      receivers: livePeers()
        .flatMap((peer) => peer.getReceivers())
        .filter((receiver) => receiver.track.kind === "audio" && receiver.track.readyState === "live").length,
      outputs: outputElements().length,
      playing: outputElements().filter((element) => !element.paused).length
    }),
    async referenceStart(iceServers) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const peer = new RTCPeerConnection({ iceServers });
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.ontrack = ({ streams }) => {
        const audio = document.createElement("audio");
        audio.dataset.reference = "true";
        audio.srcObject = streams[0];
        audio.autoplay = true;
        document.body.append(audio);
        void audio.play();
      };
      reference = { peer, stream };
    },
    async referenceOffer() {
      await reference.peer.setLocalDescription(await reference.peer.createOffer());
      await gather(reference.peer);
      return reference.peer.localDescription.toJSON();
    },
    async referenceAnswer(offer) {
      await reference.peer.setRemoteDescription(offer);
      await reference.peer.setLocalDescription(await reference.peer.createAnswer());
      await gather(reference.peer);
      return reference.peer.localDescription.toJSON();
    },
    async referenceAccept(answer) {
      await reference.peer.setRemoteDescription(answer);
    },
    referenceStop() {
      reference?.peer.close();
      reference?.stream.getTracks().forEach((track) => track.stop());
      reference = null;
      document.querySelectorAll("[data-reference]").forEach((element) => {
        element.pause();
        element.srcObject = null;
        element.remove();
      });
    }
  };
  async function gather(peer) {
    if (peer.iceGatheringState === "complete") return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.removeEventListener("icegatheringstatechange", changed);
        reject(new Error("Reference ICE gathering timed out"));
      }, 10000);
      function changed() {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(timer);
          peer.removeEventListener("icegatheringstatechange", changed);
          resolve();
        }
      }
      peer.addEventListener("icegatheringstatechange", changed);
    });
  }
}
