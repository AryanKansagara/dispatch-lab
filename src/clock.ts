/** Shared replay clock: one animation loop drives every map and readout, in simulated minutes. */
export class Clock {
  t = 0
  horizon = 1
  /** Simulated minutes per real second. */
  speed = 4
  playing = false
  loop = false
  private subs = new Set<() => void>()
  private raf = 0
  private last = 0

  subscribe(fn: () => void) {
    this.subs.add(fn)
    return () => { this.subs.delete(fn) }
  }
  notify() { for (const fn of this.subs) fn() }
  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    this.t += dt * this.speed
    if (this.t >= this.horizon) {
      if (this.loop) this.t = 0
      else { this.t = this.horizon; this.playing = false }
    }
    this.notify()
    if (this.playing) this.raf = requestAnimationFrame(this.frame)
  }
  play() {
    if (this.playing) return
    if (this.t >= this.horizon) this.t = 0
    this.playing = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    this.notify()
  }
  pause() {
    this.playing = false
    cancelAnimationFrame(this.raf)
    this.notify()
  }
  toggle() { if (this.playing) this.pause(); else this.play() }
  seek(t: number) {
    this.t = Math.max(0, Math.min(this.horizon, t))
    this.notify()
  }
  setHorizon(h: number) {
    this.horizon = Math.max(1, h)
    if (this.t > this.horizon) this.t = this.horizon
    this.notify()
  }
}

export function clockLabel(t: number, startHour?: number): string {
  if (startHour === undefined) return `T+${Math.floor(t)}m`
  const total = startHour * 60 + t
  const h = Math.floor(total / 60) % 24
  const m = Math.floor(total % 60)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
