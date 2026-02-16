/**
 * Cross-platform poll payload.
 *
 * This matches the subset of WhatsApp/Baileys poll fields we rely on today.
 * Platforms that don't support native polls can emulate the poll UI.
 */
export interface PollPayload {
  name: string;
  values: string[];

  /**
   * WhatsApp semantics:
   * - 1 = single-select
   * - 0 = unlimited selections
   */
  selectableCount: number;
}
