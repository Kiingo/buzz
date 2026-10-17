import { KeyRound } from "lucide-react";

import { SETTINGS_SECTION_LABEL } from "../lib/display";

/** Settings section id for the remote signer. */
export const REMOTE_SIGNER_SETTINGS_SECTION = "remote-signing" as const;

/** Settings sidebar entry ("Kiingo signing"). */
export const remoteSignerSettingsSection = {
  value: REMOTE_SIGNER_SETTINGS_SECTION,
  label: SETTINGS_SECTION_LABEL,
  icon: KeyRound,
};
