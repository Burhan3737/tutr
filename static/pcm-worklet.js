// Dictation's recorder (app.js): the microphone, downsampled to 16 kHz mono, posted to the page as a Float32Array
// about every 100 ms. Writes no output (silence). On the message "flush" it posts what's left, then "done".

// A windowed-sinc low-pass (Blackman): cutoff fc in cycles per sample, n taps (odd), unity gain at 0 Hz.
function lowpass(fc, n) {
  const m = (n - 1) / 2, t = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
    sum += t[i] = sinc * w;
  }
  return t.map((v) => v / sum);
}

class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;       // input samples per output sample
    this.pos = 0;                         // where the next output sample falls, counted from this block's start
    this.prev = 0;                        // the last input sample of the previous block (pos can fall before 0)
    // Above 16 kHz, what's over 7.5 kHz is filtered out first, or it would fold back into the speech (63 taps at 48 kHz).
    this.taps = sampleRate > 16000 ? lowpass(7500 / sampleRate, 2 * Math.round(31 * sampleRate / 48000) + 1) : null;
    this.hist = this.taps ? new Float32Array(this.taps.length - 1) : null;    // the input just before this block
    this.out = new Float32Array(1600);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data !== "flush") return;
      this.send();
      this.port.postMessage("done");
    };
  }
  send() {
    if (this.n) this.port.postMessage(this.out.slice(0, this.n));
    this.n = 0;
  }
  filter(x) {
    const t = this.taps, k = this.hist.length, buf = new Float32Array(k + x.length), y = new Float32Array(x.length);
    buf.set(this.hist);
    buf.set(x, k);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (let j = 0; j <= k; j++) s += t[j] * buf[i + j];
      y[i] = s;
    }
    this.hist = buf.slice(x.length);
    return y;
  }
  process(inputs) {
    let x = inputs[0] && inputs[0][0];            // the first channel: the track is mono already
    if (!x || !x.length) return true;
    if (this.taps) x = this.filter(x);
    // Linear interpolation between input samples; pos carries its fraction into the next block.
    for (; this.pos < x.length - 1; this.pos += this.step) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const a = i < 0 ? this.prev : x[i];
      this.out[this.n++] = a + (x[i + 1] - a) * f;
      if (this.n === this.out.length) this.send();
    }
    this.pos -= x.length;
    this.prev = x[x.length - 1];
    return true;
  }
}
registerProcessor("pcm16k", Pcm16k);
