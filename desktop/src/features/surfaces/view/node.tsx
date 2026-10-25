// Generated from the Kiingo surface renderer packages; do not edit here.
import type { ComponentType as ReactComponentType } from "react";
import {
  isVisible,
  MAX_DEPTH,
  type ChildRef,
  type ComponentType,
  type Pointer,
} from "../core";
import {
  ActionBarView,
  ButtonView,
  LinkView,
  MenuView,
  SuggestionChipsView,
} from "./actions";
import { ChartView } from "./chart";
import { useNodeContext, type NodeProps } from "./context";
import { ListView, TableView } from "./data";
import {
  AvatarView,
  BadgeView,
  CalloutView,
  CodeView,
  CountdownView,
  DiffView,
  EntityRefView,
  FileListView,
  IconView,
  ImageGalleryView,
  ImageView,
  KeyValueView,
  LinkPreviewView,
  MapView,
  MarkdownView,
  MediaView,
  MetricView,
  ProgressView,
  QuoteView,
  TextView,
  TimelineView,
} from "./display";
import { Glyphs } from "./icons";
import { InputView } from "./inputs";
import {
  AccordionView,
  CardView,
  CarouselView,
  DividerView,
  GridView,
  ModalView,
  SectionView,
  StackView,
  StepsView,
  TabsView,
} from "./layout";

/**
 * One view per catalog type (§4). Every type in `COMPONENT_TYPES` has one.
 * Built on first use: the container views import `Children` from here, so
 * the table can't be read while those modules are still loading.
 */
let views: Record<ComponentType, ReactComponentType<NodeProps>> | undefined;

export const viewFor = (
  type: ComponentType,
): ReactComponentType<NodeProps> | undefined => {
  views ??= makeViews();
  return views[type];
};

const makeViews = (): Record<ComponentType, ReactComponentType<NodeProps>> => ({
  Stack: StackView,
  Grid: GridView,
  Section: SectionView,
  Card: CardView,
  Tabs: TabsView,
  Accordion: AccordionView,
  Carousel: CarouselView,
  Steps: StepsView,
  Divider: DividerView,
  Modal: ModalView,
  Text: TextView,
  Markdown: MarkdownView,
  Image: ImageView,
  ImageGallery: ImageGalleryView,
  Icon: IconView,
  Badge: BadgeView,
  Avatar: AvatarView,
  KeyValue: KeyValueView,
  Table: TableView,
  List: ListView,
  Chart: ChartView,
  Metric: MetricView,
  Progress: ProgressView,
  Timeline: TimelineView,
  Code: CodeView,
  Diff: DiffView,
  Callout: CalloutView,
  Quote: QuoteView,
  EntityRef: EntityRefView,
  FileList: FileListView,
  Media: MediaView,
  LinkPreview: LinkPreviewView,
  Map: MapView,
  Countdown: CountdownView,
  TextField: InputView,
  RichTextEditor: InputView,
  RecipientField: InputView,
  Select: InputView,
  ChoicePicker: InputView,
  Checkbox: InputView,
  Toggle: InputView,
  Slider: InputView,
  Stepper: InputView,
  DateTimeInput: InputView,
  Rating: InputView,
  FileInput: InputView,
  EntityPicker: InputView,
  Reorder: InputView,
  TimeSlotPicker: InputView,
  Button: ButtonView,
  ActionBar: ActionBarView,
  SuggestionChips: SuggestionChipsView,
  Menu: MenuView,
  Link: LinkView,
});

/** A part this app can't draw (a newer catalog type). Never its raw props. */
export const NewerAppRow = ({
  text = "Part of this needs a newer version of the app.",
}: {
  text?: string;
}) => (
  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <Glyphs.newer aria-hidden className="h-3.5 w-3.5 shrink-0" />
    {text}
  </p>
);

/** One component by id at one scope; hidden by `visibleWhen`, cut off past depth 12. */
export const Node = ({
  componentId,
  scope,
  depth,
}: {
  componentId: string;
  scope: Pointer;
  depth: number;
}) => {
  const context = useNodeContext();
  if (depth > MAX_DEPTH) {
    return null;
  }
  const component = context.surface.components.get(componentId);
  if (!component) {
    return null;
  }
  if (!isVisible(component.visibleWhen, context.data, scope)) {
    return null;
  }
  const View = component.known
    ? viewFor(component.type as ComponentType)
    : undefined;
  if (!View) {
    return <NewerAppRow />;
  }
  return <View component={component} scope={scope} depth={depth} />;
};

/** A container's children, one level deeper. */
export const Children = ({
  refs,
  depth,
}: {
  refs: ChildRef[];
  depth: number;
}) => (
  <>
    {refs.map((ref) => (
      <Node
        key={ref.key}
        componentId={ref.componentId}
        scope={ref.scope}
        depth={depth + 1}
      />
    ))}
  </>
);
