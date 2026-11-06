// ===== サウンド =====
const snd = {
  ctx: null, on: true,
  init() { if (!this.ctx) { const A = window.AudioContext || window.webkitAudioContext; if (A) this.ctx = new A(); } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  tone(fs, dur, type, vol, gap) {
    if (!this.on) return; this.init(); if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    fs.forEach((f, k) => { const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.type = type; o.frequency.value = f; const t = t0 + k * gap; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.01, t + dur); o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t + dur); });
  },
  place() { this.tone([220], .09, 'triangle', .35, 0); }, cap() { this.tone([523, 659, 784], .12, 'sine', .2, .05); },
  click() { this.tone([600], .04, 'sine', .1, 0); }, win() { this.tone([523, 659, 784, 1046], .3, 'triangle', .25, .1); }
};
