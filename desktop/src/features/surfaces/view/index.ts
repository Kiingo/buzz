// Generated from the Kiingo surface renderer packages at 0d7eecf6d3b78f4c52514554faa33adb7a1fe131; do not edit here.
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
export type {
  MediaAnswer,
  SurfaceHost,
  UploadAnswer,
  UploadedFile,
  UploadTarget,
} from "./host";
export { ProxyImage } from "./media";
export { MarkdownText } from "./markdown";
export { CHART_SLOT_CLASSES } from "./chart";
export { CopyButton, copyToClipboard } from "./copy";
