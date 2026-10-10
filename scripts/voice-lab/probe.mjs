// Injected only by the lab into its disposable, fixture-only browser contexts.
// It is never bundled into Voxly or installed in a member's browser.
export function installProbe({ relay = false, bufferTarget = null } = {}) {
  const peers = new Set();
  const captures = new Set();
  const peerAliases = new WeakMap();
  const streamAliases = new WeakMap();
  let peerSequence = 0;
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await nativeCapture(...args);
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
        if (bufferTarget !== null && "jitterBufferTarget" in receiver) receiver.jitterBufferTarget = bufferTarget;
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
  async function record(seconds = 6) {
    if (seconds < 0.1 || seconds > 30) throw new Error("Fixture recording must be bounded to 30 seconds");
    const context = new AudioContext({ sampleRate: 48000 });

    const module = URL.createObjectURL(
      new Blob(
        [
          `
      class Probe extends AudioWorkletProcessor {
        constructor() { super(); this.data = new Float32Array(4800); this.offset = 0; }
        process(inputs) {
          const input = inputs[0]?.[0];
          if (input) for (const sample of input) {
            this.data[this.offset++] = sample;
            if (this.offset === this.data.length) {
              this.port.postMessage(this.data); this.offset = 0;
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
    const recordings = [];
    const nodes = [];
    try {
      await context.audioWorklet.addModule(module);
      const streams = [
        ...liveCaptures().map((stream) => ["capture", stream]),
        ...livePeers().flatMap((peer) =>
          peer
            .getSenders()
            .filter((sender) => sender.track?.kind === "audio")
            .map((sender) => ["published", new MediaStream([sender.track])])
        ),
        ...outputElements().map((element) => ["received", element.srcObject])
      ];
      for (const [stage, stream] of streams) {
        const source = context.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(context, "voice-lab-probe");
        const silent = context.createGain();
        silent.gain.value = 0;
        const chunks = [];
        node.port.onmessage = (event) => chunks.push(...event.data);
        source.connect(node).connect(silent).connect(context.destination);
        nodes.push(source, node, silent);
        recordings.push({ stage, samples: chunks });
      }
      await context.resume();
      const statsBefore = await stats();
      const startedAt = performance.timeOrigin + performance.now();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return {
        startedAt,
        statsBefore,
        sampleRate: context.sampleRate,
        recordings,
        stats: await stats(),
        output: outputElements().map((element) => ({
          paused: element.paused,
          muted: element.muted,
          volume: element.volume,
          readyState: element.readyState
        }))
      };
    } finally {
      nodes.forEach((node) => {
        node.disconnect();
        node.port?.close();
      });
      await context.close();
      URL.revokeObjectURL(module);
    }
  }
  let reference = null;
  window.voiceLab = {
    record,
    stats,
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
