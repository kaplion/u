/**
 * Çalışma modları. Mod her log satırında ve her alarmda görünür —
 * karıştırılması imkânsız olmalı.
 */
export type Mode = "DRY_RUN" | "PAPER" | "LIVE";

export const MODES: readonly Mode[] = ["DRY_RUN", "PAPER", "LIVE"];

export function parseMode(value: string | undefined): Mode {
  if (value === undefined || value === "") {
    // Güvenli varsayılan: asla LIVE değil.
    return "DRY_RUN";
  }
  if ((MODES as readonly string[]).includes(value)) {
    return value as Mode;
  }
  throw new Error(
    `Geçersiz mod: "${value}". Geçerli değerler: ${MODES.join(", ")}`,
  );
}
