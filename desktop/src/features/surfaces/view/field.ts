// Generated from the Kiingo surface renderer packages at c72e3863b9419a77a51b527a9ff4255646c6384c; do not edit here.
import type { Pointer, SurfaceComponent } from "../core";

/** What every §4.3 input gets from `InputView` (shared by inputs and pickers). */
export type FieldProps = {
  component: SurfaceComponent;
  scope: Pointer;
  pointer: Pointer;
  id: string;
  label: string;
  placeholder: string;
  disabled: boolean;
  describedBy?: string;
  invalid: boolean;
};

export const aria = (props: FieldProps) => ({
  "aria-describedby": props.describedBy,
  "aria-invalid": props.invalid || undefined,
});

/** The zone if this runtime knows it, else undefined (the device's own). */
export const validZone = (zone: string | undefined): string | undefined => {
  if (!zone) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
};
