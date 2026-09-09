import type * as React from "react";

import { KIND_AGENT_STATUS } from "@/shared/constants/kinds";
import { AgentStatusRow } from "./AgentStatusRow";
import { MessageRow } from "./MessageRow";

type MessageThreadRowProps = Omit<
  React.ComponentProps<typeof MessageRow>,
  "layoutVariant"
>;

/** The canonical message-row presentation used inside channel threads. */
export function MessageThreadRow(props: MessageThreadRowProps) {
  if (props.message.kind === KIND_AGENT_STATUS) {
    return <AgentStatusRow message={props.message} />;
  }
  return <MessageRow {...props} layoutVariant="thread-reply" />;
}
