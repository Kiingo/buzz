// Generated from the Kiingo surface renderer packages at 568e78caaf0a85a2acc80a0a93b78d1ff84bdef1; do not edit here.
import { useEffect, useState } from "react";
import { proxiedMediaUrl } from "../core";
import { cn } from "./cn";
import { useNodeContext } from "./context";
import { fetchMedia } from "./host";
import { Glyphs } from "./icons";

/**
 * An image from the signed Kiingo proxy (`/api/ui/media?token=` on the API
 * host), else its alt text (§3.1, §10). Loaded with no credentials as a
 * blob of a checked raster type; a 401/410 reads the surface again so the
 * URL is re-signed, at most once a minute.
 */
export const ProxyImage = ({
  url,
  alt,
  fit = "contain",
  aspect,
  className,
  rounded = "rounded-md",
}: {
  url: unknown;
  alt: string;
  fit?: "cover" | "contain";
  /** width / height */
  aspect?: number;
  className?: string;
  rounded?: string;
}) => {
  const context = useNodeContext();
  const host = context.host;
  const proxied = proxiedMediaUrl(url, host.apiOrigin);
  const controller = context.controller;
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    setSrc(undefined);
    if (!proxied) {
      return undefined;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    const load = host.loadMedia ?? fetchMedia;
    void load(proxied).then((answer) => {
      if (cancelled) {
        return;
      }
      if (answer.kind === "image") {
        objectUrl = URL.createObjectURL(answer.blob);
        setSrc(objectUrl);
      } else if (answer.kind === "expired") {
        void controller.refreshForExpiredMedia();
      }
    });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // The controller is stable per surface; a re-signed URL reloads.
  }, [proxied, host, controller]);

  const style = aspect ? { aspectRatio: String(aspect) } : undefined;
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        style={style}
        referrerPolicy="no-referrer"
        draggable={false}
        className={cn(
          "block max-h-80 w-full bg-muted",
          fit === "cover" ? "object-cover" : "object-contain",
          rounded,
          className,
        )}
      />
    );
  }
  return (
    <div
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      style={style}
      className={cn(
        "flex min-h-[2.5rem] w-full items-center gap-2 bg-muted/60 px-2 py-2 text-xs text-muted-foreground",
        rounded,
        className,
      )}
    >
      <Glyphs.image aria-hidden className="h-4 w-4 shrink-0" />
      <span className="truncate">{alt || "Image"}</span>
    </div>
  );
};
