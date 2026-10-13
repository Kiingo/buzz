import * as React from "react";

import { useBackendProvidersQuery } from "@/features/agents/hooks";
import {
  configuredPreferredRunOn,
  findPreferredProvider,
} from "../lib/preferredRunOn";
import { emptyWhereToRunDraft, type WhereToRunDraft } from "./whereToRunIntent";

/** How a run draft changed: by the user, or by the app filling it in. */
export type WhereToRunDraftSource = "user" | "app";

/**
 * Create-flow run draft that starts on the build's preferred destination once
 * that provider is discovered. The default is applied only until the user
 * picks something themselves, and app-driven changes (the default itself, a
 * probe result) never mark the dialog dirty.
 */
export function usePreferredWhereToRunDraft(onUserChange?: () => void): {
  draft: WhereToRunDraft;
  setDraft: (next: WhereToRunDraft, source?: WhereToRunDraftSource) => void;
  preferredActive: boolean;
} {
  const providers = useBackendProvidersQuery().data;
  const preferred = React.useMemo(
    () => findPreferredProvider(providers ?? [], configuredPreferredRunOn()),
    [providers],
  );
  const [draft, setDraftState] = React.useState(emptyWhereToRunDraft);
  const userChoseRef = React.useRef(false);

  React.useEffect(() => {
    if (!preferred || userChoseRef.current) return;
    setDraftState((current) =>
      current.runOn === "local"
        ? { ...emptyWhereToRunDraft, runOn: preferred.id }
        : current,
    );
  }, [preferred]);

  const setDraft = React.useCallback(
    (next: WhereToRunDraft, source: WhereToRunDraftSource = "user") => {
      if (source === "user") {
        userChoseRef.current = true;
        onUserChange?.();
      }
      setDraftState(next);
    },
    [onUserChange],
  );

  return { draft, setDraft, preferredActive: preferred !== null };
}
