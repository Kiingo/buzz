import { resetGuestTurns } from "./guestReply";
import { resetGuestAccessStore } from "./store";

/** Clear every community-scoped guest-access singleton. */
export function resetGuestAccessState() {
  resetGuestAccessStore();
  resetGuestTurns();
}
