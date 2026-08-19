import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { MediaStream, MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from "werift";
import { opusCodec } from "../src/mesh.js";

/**
 * The library behaviour the spike leans on, pinned so a werift upgrade cannot
 * change it quietly. These bind two loopback UDP sockets; an EPERM here is a
 * sandbox limit rather than a failure.
 */
describe("werift", () => {
  const connections: RTCPeerConnection[] = [];
  after(async () => {
    await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
  });

  it("rewrites the header of the packet it is handed", async () => {
    // This is why every Listener gets its own packet object. werift stores the
    // object it was given in its retransmission cache, so one object shared
    // between two senders leaves each cache holding the other's identity.
    const track = new MediaStreamTrack({ kind: "audio" });
    const { sender } = await connectedPair(connections, track);
    const packet = new RtpPacket(
      new RtpHeader({ payloadType: 96, sequenceNumber: 500, timestamp: 0, ssrc: 0 }),
      Buffer.alloc(40, 3)
    );

    track.writeRtp(packet);
    await settle();

    assert.equal(packet.header.ssrc, sender.getSenders()[0]?.ssrc);
    assert.equal(packet.header.payloadType, opusCodec.payloadType);
  });

  it("delivers Opus payloads unchanged to the far side", async () => {
    const track = new MediaStreamTrack({ kind: "audio" });
    const { remoteTrack } = await connectedPair(connections, track);
    const received: Buffer[] = [];
    (await remoteTrack).onReceiveRtp.subscribe((rtp) => received.push(rtp.payload));

    const payloads = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])];
    payloads.forEach((payload, index) => {
      track.writeRtp(new RtpPacket(
        new RtpHeader({ payloadType: 111, sequenceNumber: 900 + index, timestamp: index * 960 }),
        payload
      ));
    });
    await settle();

    assert.deepEqual(received, payloads);
  });
});

async function connectedPair(connections: RTCPeerConnection[], track?: MediaStreamTrack) {
  const sender = new RTCPeerConnection({ codecs: { audio: [opusCodec] } });
  const receiver = new RTCPeerConnection({ codecs: { audio: [opusCodec] } });
  connections.push(sender, receiver);
  if (track) sender.addTrack(track, new MediaStream({ id: "music", tracks: [] }));
  else sender.addTransceiver("audio", { direction: "sendonly" });

  // onTrack fires during negotiation, so subscribe before it starts.
  const remoteTrack = new Promise<MediaStreamTrack>((resolve) => receiver.onTrack.subscribe(resolve));

  sender.onIceCandidate.subscribe((candidate) => candidate && void receiver.addIceCandidate(candidate));
  receiver.onIceCandidate.subscribe((candidate) => candidate && void sender.addIceCandidate(candidate));

  await receiver.setRemoteDescription(await sender.setLocalDescription(await sender.createOffer()));
  await sender.setRemoteDescription(await receiver.setLocalDescription(await receiver.createAnswer()));
  if (sender.connectionState !== "connected") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stuck at ${sender.connectionState}`)), 10_000);
      sender.connectionStateChange.subscribe((state) => {
        if (state !== "connected") return;
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return { sender, receiver, remoteTrack };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 300));
}
