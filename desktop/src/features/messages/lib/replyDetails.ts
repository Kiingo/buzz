/** Kiingo mission reply metadata carried as event tags instead of chat text. */
export const KIINGO_MISSION_TAG = "kiingo-mission";
export const KIINGO_DETAILS_URL_TAG = "kiingo-details";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ReplyDetails = {
  /** Mission the reply belongs to. */
  missionId: string | null;
  /** HTTPS page with the mission's status, steering and Stop. */
  detailsUrl: string | null;
};

function singleTagValue(
  tags: readonly (readonly string[])[] | undefined,
  name: string,
): string | null {
  const values = (tags ?? []).filter(
    (tag) => tag[0] === name && typeof tag[1] === "string",
  );
  return values.length === 1 ? values[0][1] : null;
}

function safeHttpsUrl(value: string | null): string | null {
  if (!value || value.length > 512) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Reads the reply's mission details. Missing, duplicated or malformed tags
 *  yield null fields rather than a partial or unsafe link. */
export function readReplyDetails(
  tags: readonly (readonly string[])[] | undefined,
): ReplyDetails {
  const mission = singleTagValue(tags, KIINGO_MISSION_TAG)?.toLowerCase() ?? null;
  return {
    missionId: mission && UUID_PATTERN.test(mission) ? mission : null,
    detailsUrl: safeHttpsUrl(singleTagValue(tags, KIINGO_DETAILS_URL_TAG)),
  };
}
