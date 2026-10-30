// Generated from the Kiingo surface renderer packages at 31af16c4bf4bf2ccee353af7c8c836d4be5d621a; do not edit here.
// The surface renderer (kiingo.ui/v1). Logic lives in ../core; this folder only draws it.

export { SurfaceView, SurfaceExpandedDialog } from "./SurfaceView";
export { ConfirmationDialog } from "./confirm";
export { NewerAppRow, Node, Children, viewFor } from "./node";
export {
  NodeContext,
  NodeContextContext,
  useNodeContext,
  useSurfaceSnapshot,
} from "./context";
export type { NodeProps, SurfaceMode } from "./context";
export {
  defaultIsOutside,
  fetchMedia,
  MAX_IMAGE_BYTES,
  SurfaceHostContext,
  useSurfaceHost,
} from "./host";
export type { MediaAnswer, SurfaceHost, UploadedFile } from "./host";
export { ProxyImage } from "./media";
export { MarkdownText } from "./markdown";
export { CHART_SLOT_CLASSES } from "./chart";
export { CopyButton, copyToClipboard } from "./copy";
