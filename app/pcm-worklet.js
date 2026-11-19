// Riproduce PCM float stereo interleaved ricevuto via port in un nodo audio.
const RATE = 48000;
class Pcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0; this.size = 0; this.primed = false;
    this.port.onmessage = e => {
      this.q.push(e.data); this.size += e.data.length;
      // ponytail: tetto fisso di 250 ms, oltre scarta il più vecchio per non accumulare ritardo
      while (this.size > RATE * 2 * 0.25) { this.size -= this.q[0].length - this.off; this.q.shift(); this.off = 0; }
    };
  }
  process(_in, [out]) {
    const [L, R] = out;
    if (!this.primed && this.size < RATE * 2 * 0.04) return true; // 40 ms di pre-buffer contro i crack
    this.primed = true;
    for (let i = 0; i < L.length; i++) {
      const b = this.q[0];
      if (!b) { this.primed = false; break; }
      L[i] = b[this.off++]; R[i] = b[this.off++]; this.size -= 2;
      if (this.off >= b.length) { this.q.shift(); this.off = 0; }
    }
    return true;
  }
}
registerProcessor('pcm', Pcm);
