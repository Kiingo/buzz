export type OutsideAppCard = {
  surfaceId: string;
  revision: number;
  title: string;
  conversationId: string;
  conversationTitle: string;
  appName: string;
};
export type OutsideAppCardsPage = {
  surfaces: OutsideAppCard[];
  nextBefore: string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOutsideCardsCursor = (value: unknown): value is string =>
  typeof value === "string" && /^v1\.[A-Za-z0-9_-]{32}$/.test(value);
export function decodeOutsideAppCards(value: unknown): OutsideAppCardsPage {
  const page = value as Partial<OutsideAppCardsPage> | null;
  if (
    !page ||
    !Array.isArray(page.surfaces) ||
    page.surfaces.length > 50 ||
    !(page.nextBefore === null || isOutsideCardsCursor(page.nextBefore))
  ) {
    throw new Error("Cards are unavailable. Try refreshing.");
  }
  const surfaces = page.surfaces.map((row) => {
    if (
      !row ||
      !uuid.test(row.surfaceId) ||
      !uuid.test(row.conversationId) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      typeof row.title !== "string" ||
      row.title.length > 300 ||
      typeof row.conversationTitle !== "string" ||
      row.conversationTitle.length > 300 ||
      typeof row.appName !== "string" ||
      row.appName.length > 200
    ) {
      throw new Error("Cards are unavailable. Try refreshing.");
    }
    return row;
  });
  return { surfaces, nextBefore: page.nextBefore };
}
