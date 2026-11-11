import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Layers } from "lucide-react";
import { toast } from "sonner";
import { invokeTauri } from "@/shared/api/tauri";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { SurfaceView } from "../view";
import type { SurfaceController } from "../core";
import { surfaceApiOrigin, surfaceStore } from "../lib/surfaceStore";
import {
  decodeOutsideAppCards,
  type OutsideAppCard,
} from "../lib/outsideAppCards";

function OutsideCard({ card }: { card: OutsideAppCard }) {
  const [controller, setController] = React.useState<SurfaceController | null>(
    null,
  );
  React.useEffect(() => {
    let current = true;
    void surfaceStore()
      .load(card.surfaceId, card.revision)
      .then((value) => {
        if (current) setController(value ?? null);
      })
      .catch(() => {
        if (current) setController(null);
      });
    return () => {
      current = false;
    };
  }, [card.surfaceId, card.revision]);
  return (
    <section
      className="rounded-lg border border-border p-4"
      aria-label={card.conversationTitle}
    >
      <h3 className="mb-3 text-sm font-medium">{card.conversationTitle}</h3>
      {controller ? (
        <SurfaceView
          controller={controller}
          host={{
            apiOrigin: surfaceApiOrigin() ?? "https://invalid.invalid",
            openUrl: (url) => {
              void openUrl(url).catch(() =>
                toast.error("Couldn’t open that link."),
              );
            },
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Card unavailable. Refresh to try again.
        </p>
      )}
    </section>
  );
}

/** Private Kiingo card accessory; no synthetic Agent or relay message. */
export function OutsideAppCards() {
  const [open, setOpen] = React.useState(false);
  const { activeCommunity, reinitKey } = useCommunities();
  const identity = useIdentityQuery().data?.pubkey;
  const query = useInfiniteQuery({
    queryKey: [
      "kiingo-outside-app-cards",
      activeCommunity?.id,
      reinitKey,
      identity,
    ],
    enabled: open,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const result = await invokeTauri<{ status: number; body: unknown }>(
        "agent_ui_request",
        {
          method: "GET",
          path: pageParam ? `outside-apps/${pageParam}` : "outside-apps",
        },
      );
      if (result.status !== 200)
        throw new Error(
          "Couldn’t load your cards. Check your Kiingo connection and retry.",
        );
      return decodeOutsideAppCards(result.body);
    },
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    refetchInterval: 15_000,
    gcTime: 0,
    retry: false,
  });
  const cards = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.surfaces)
        .map((card) => [card.surfaceId, card]) ?? [],
    ).values(),
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cards from outside apps"
          title="Cards from outside apps"
        >
          <Layers className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cards from outside apps</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Your private Kiingo conversations. Open a card in Kiingo to answer or
          act.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            void query.refetch();
          }}
          disabled={query.isFetching}
        >
          Refresh
        </Button>
        {query.isError ? (
          <p role="alert">{query.error.message}</p>
        ) : query.isPending ? (
          <p role="status">Loading cards…</p>
        ) : (
          <>
            {cards.length === 0 && (
              <p>
                No cards yet. Render a card from Claude, Codex, or another
                connected app.
              </p>
            )}
            {cards.map((card) => (
              <OutsideCard key={card.surfaceId} card={card} />
            ))}
            {query.hasNextPage && (
              <Button
                onClick={() => {
                  void query.fetchNextPage();
                }}
                disabled={query.isFetching}
              >
                Load older cards
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
