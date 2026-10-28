/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * Mic capture for the kiingo-voice-v1 stream (voice-provider-neutral §10.4):
 * mono, resampled from the context rate to 16 kHz by linear interpolation
 * (the graph low-passes first), converted to s16, and posted in fixed frames
 * (default 40 ms = 640 samples) as transferable Int16Array buffers.
 *
 * Served from the app's own origin (script-src 'self'); never inlined as a
 * blob URL.
 */
class KiingoPcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = (options && options.processorOptions) || {};
    this.targetRate = settings.targetRate || 16000;
    this.frameSamples = settings.frameSamples || 640;
    this.step = sampleRate / this.targetRate;
    // Read position into [last, ...block]; index 0 is the previous block's
    // last sample.
    this.position = 0;
    this.last = 0;
    this.frame = new Int16Array(this.frameSamples);
    this.fill = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.running = false;
      }
    };
  }

  emit(sample) {
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    this.frame[this.fill++] =
      clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    if (this.fill === this.frameSamples) {
      const full = this.frame;
      this.port.postMessage(full, [full.buffer]);
      this.frame = new Int16Array(this.frameSamples);
      this.fill = 0;
    }
  }

  process(inputs) {
    if (!this.running) {
      return false;
    }
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true;
    }
    const channels = input.length;
    const length = input[0].length;
    let mono = input[0];
    if (channels > 1) {
      mono = new Float32Array(length);
      for (let c = 0; c < channels; c++) {
        const data = input[c];
        for (let i = 0; i < length; i++) {
          mono[i] += data[i] / channels;
        }
      }
    }
    let position = this.position;
    while (position < length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = index === 0 ? this.last : mono[index - 1];
      const b = mono[index];
      this.emit(a + (b - a) * fraction);
      position += this.step;
    }
    this.position = position - length;
    this.last = mono[length - 1];
    return true;
  }
}

registerProcessor("kiingo-pcm16-capture", KiingoPcm16Capture);
