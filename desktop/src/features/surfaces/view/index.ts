// Generated from the Kiingo surface renderer packages at f7dffff48426f852528f24ecb4cb04fb5bc2d5b2; do not edit here.
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
  FileAnswer,
  FileImageAnswer,
  FileModelAnswer,
  MediaAnswer,
  SurfaceFileCard,
  SurfaceFileImageRequest,
  SurfaceFileModelRequest,
  SurfaceFileOpen,
  SurfaceFileRef,
  SurfaceHost,
  UploadAnswer,
  UploadedFile,
  UploadTarget,
  WorkViewAnswer,
  WorkViewHost,
} from "./host";
export { ProxyImage } from "./media";
export { InlineMarkdown, MarkdownText } from "./markdown";
export { CHART_SLOT_CLASSES } from "./chart";
export { CopyButton, copyToClipboard } from "./copy";
