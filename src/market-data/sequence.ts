/**
 * Sequence number takibi — WS akışında boşluk (kaçırılmış mesaj) tespiti.
 * Boşluk görülünce REST snapshot ile resync gerekir; kaldığın yerden
 * devam ettiğini varsayamazsın.
 */
export type SequenceCheck = "ok" | "gap" | "duplicate";

export class SequenceTracker {
  private last: number | undefined;

  next(seq: number): SequenceCheck {
    if (this.last === undefined) {
      this.last = seq;
      return "ok";
    }
    if (seq <= this.last) return "duplicate";
    const check: SequenceCheck = seq === this.last + 1 ? "ok" : "gap";
    this.last = seq;
    return check;
  }

  /** Resync sonrası çağrılır — yeni akış baştan izlenir. */
  reset(): void {
    this.last = undefined;
  }
}
