#!/usr/bin/env python3
"""Scripted ACP agent for buzz-acp end-to-end tests.

Speaks newline-delimited JSON-RPC on stdio. Every `session/prompt` is
appended to $FAKE_AGENT_LOG (one JSON object per line) so a test can prove
exactly what reached the local agent session. The agent then answers with
"ACK <token>" for the newest TOKEN-... in the prompt; buzz-acp's reply
fallback publishes that text in the triggering thread.

If the newest event's content contains `ASK-AGENT:<64-hex>`, the agent first
runs `buzz messages send` mentioning that pubkey (exercising the CLI's signed
relay tags), using $FAKE_AGENT_BUZZ_BIN and $FAKE_AGENT_RELAY_HTTP.
"""

import json
import os
import re
import subprocess
import sys
import time

LOG = os.environ.get("FAKE_AGENT_LOG")
DELAY = float(os.environ.get("FAKE_AGENT_DELAY", "2"))
TOKEN = re.compile(r"TOKEN-[A-Za-z0-9]+")
ASK = re.compile(r"ASK-AGENT:([0-9a-f]{64})")
MARK = re.compile(r"CLASSIFY-[A-Z]+")
CHANNEL = re.compile(r"Channel: .*?\(#([0-9a-f-]{36})\)")
EVENT_ID = re.compile(r"Event ID: ([0-9a-f]{64})")


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def prompt_text(params):
    parts = []
    for block in params.get("prompt", []):
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts)


def handle_prompt(msg_id, params):
    session = params.get("sessionId", "s")
    text = prompt_text(params)
    if LOG:
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps({"session": session, "text": text}) + "\n")
    time.sleep(DELAY)
    tokens = TOKEN.findall(text)
    asks = ASK.findall(text)
    channels = CHANNEL.findall(text)
    event_ids = EVENT_ID.findall(text)
    if asks and channels and os.environ.get("FAKE_AGENT_BUZZ_BIN"):
        cmd = [
            os.environ["FAKE_AGENT_BUZZ_BIN"],
            "--relay",
            os.environ.get("FAKE_AGENT_RELAY_HTTP", "http://localhost:3000"),
            "messages",
            "send",
            "--channel",
            channels[-1],
            "--content",
            "Question for you about " + (tokens[-1] if tokens else "this")
            + "".join(" " + m for m in MARK.findall(text)[-1:]),
            "--mention",
            asks[-1],
        ]
        if event_ids:
            cmd += ["--reply-to", event_ids[-1]]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if LOG:
            with open(LOG, "a", encoding="utf-8") as log:
                log.write(json.dumps({"ask": asks[-1], "rc": result.returncode,
                                      "out": result.stdout[-2000:],
                                      "err": result.stderr[-2000:]}) + "\n")
    reply = "ACK " + (tokens[-1] if tokens else "none")
    send({"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": session,
        "update": {"sessionUpdate": "agent_message_chunk",
                   "content": {"type": "text", "text": reply}}}})
    send({"jsonrpc": "2.0", "id": msg_id, "result": {"stopReason": "end_turn"}})


def main():
    sessions = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        method = msg.get("method")
        msg_id = msg.get("id")
        if msg_id is None:
            continue  # notification (e.g. session/cancel)
        if method is None:
            continue  # response to something we never sent
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {
                "protocolVersion": 2, "agentCapabilities": {}, "authMethods": []}})
        elif method == "session/new":
            sessions += 1
            send({"jsonrpc": "2.0", "id": msg_id,
                  "result": {"sessionId": "fake-session-%d" % sessions}})
        elif method == "session/prompt":
            handle_prompt(msg_id, msg.get("params", {}))
        else:
            send({"jsonrpc": "2.0", "id": msg_id, "result": {}})


if __name__ == "__main__":
    main()
