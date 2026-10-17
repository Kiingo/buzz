import assert from "node:assert/strict";
import test from "node:test";

import { readReplyDetails } from "./replyDetails.ts";

const MISSION = "317b1210-8058-4108-9ad1-72295f165ac4";
const URL = `https://dashboard.kiingo.com/team/missions/${MISSION}`;

test("reads the mission and its https details page", () => {
  assert.deepEqual(
    readReplyDetails([
      ["h", "channel"],
      ["kiingo-mission", MISSION.toUpperCase()],
      ["kiingo-details", URL],
    ]),
    { missionId: MISSION, detailsUrl: URL },
  );
});

test("ignores missing, duplicated or unsafe values", () => {
  assert.deepEqual(readReplyDetails(undefined), {
    missionId: null,
    detailsUrl: null,
  });
  assert.deepEqual(
    readReplyDetails([
      ["kiingo-mission", "not-a-uuid"],
      ["kiingo-details", "javascript:alert(1)"],
    ]),
    { missionId: null, detailsUrl: null },
  );
  assert.deepEqual(
    readReplyDetails([
      ["kiingo-mission", MISSION],
      ["kiingo-mission", MISSION],
      ["kiingo-details", "http://dashboard.kiingo.com/x"],
    ]),
    { missionId: null, detailsUrl: null },
  );
});

test("recognizes only the retired acknowledgment and delay notices", async () => {
  const { isRetiredMissionNotice } = await import("./replyDetails.ts");
  assert.equal(
    isRetiredMissionNotice(
      "Kiingo platform notice — request received; your agent will reply in this thread\n\nMission: https://x",
    ),
    true,
  );
  assert.equal(
    isRetiredMissionNotice(
      "Kiingo platform notice — your agent has not replied yet\n\nMission: https://x",
    ),
    true,
  );
  assert.equal(
    isRetiredMissionNotice("Kiingo platform notice — Stopped as requested."),
    false,
  );
  assert.equal(isRetiredMissionNotice("request received"), false);
});
