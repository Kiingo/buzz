// Generated from the Kiingo surface renderer packages at 0d7eecf6d3b78f4c52514554faa33adb7a1fe131; do not edit here.
/** The app's words for the surface codes the server may send without a sentence. */
export const surfaceMessage = (code: string): string => {
  switch (code) {
    case "ui_surface_revision_stale":
      return "This changed. Here’s the latest; check it and try again.";
    case "ui_surface_locked":
    case "ui_surface_closed":
      return "This is no longer open.";
    case "ui_surface_not_found":
      return "This isn’t available anymore.";
    case "ui_action_unknown":
      return "This button isn’t on the card anymore. Ask the agent to fix it.";
    case "ui_action_client_side":
      return "This button works here, not on Kiingo.";
    case "ui_action_identity_refused":
      return "This can’t be done from here.";
    case "ui_action_unavailable":
      return "This can’t run right now. Try again later.";
    case "ui_action_in_progress":
      return "That’s already running.";
    case "ui_action_recipient_cap":
      return "That’s more than 25 recipients.";
    case "database_unavailable":
      return "Kiingo is busy. Try again in a moment.";
    case "invalid_request":
      return "Kiingo didn’t accept that change.";
    case "ui_surface_forbidden":
    case "ui_surface_not_editor":
      return "Only the person it was made for can change this.";
    case "ui_action_not_bindable":
    case "ui_action_not_allowed":
      return "This action isn’t allowed here.";
    case "ui_action_arg_not_visible":
      return "This action needs details that aren’t shown. Ask the agent to fix it.";
    case "ui_confirm_expired":
    case "ui_confirm_nonce_invalid":
      return "The confirmation expired. Tap again to see it fresh.";
    case "ui_validation_failed":
      return "Some fields need fixing first.";
    case "ui_action_failed":
      return "That didn’t work.";
    case "rate_limited":
      return "Too many changes just now. Try again in a moment.";
    default:
      return "That didn’t go through.";
  }
};

/** Shown on a run button wherever direct actions aren't available on this client. */
export const RUN_UNAVAILABLE_TEXT = "Open in the Kiingo app";
export const RUN_UNAVAILABLE_HINT =
  "Buttons that send or change things work in the Kiingo app on your iPhone or Mac.";

/** A view-only host (`ControllerOptions.editsDisabled`): changes happen in Kiingo. */
export const VIEW_ONLY_HINT =
  "View only here. Open it in Kiingo to make changes.";
