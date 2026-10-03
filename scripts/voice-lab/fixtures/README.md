# Fixture provenance

`speech.wav` is synthetic speech generated locally with the macOS Samantha
voice at 48 kHz, mono PCM16. It contains no member conversation:

> Please check the voice connection. We can hear each other clearly.
> One, two, three, four, five.

The lab derives digital silence and repeatable low-level white noise added to
this same speech. The generated WAVs and all captures go into the ignored
results directory. `VOICE_LAB_SPEECH` can replace this with another licensed,
non-private mono 48 kHz PCM16 fixture. Never use a recorded member conversation.

These fixtures measure continuity, level and timing. They do not establish a
perceptual speech-quality score or model an actual headset's hardware mute.
