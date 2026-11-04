import { Show } from "solid-js";
import type { VehicleInfo } from "../vehicles/store";
import type { Mode } from "../vehicles/types";
import { formatDelay } from "./formatDelay";

const MODE_LABEL: Record<Mode, string> = {
  bus: "buss",
  coach: "ekspressbuss",
  ferry: "ferje",
  train: "tog",
  other: "annet",
};

function heading(journey: VehicleInfo["journey"]): string {
  if (!journey) return "Ingen linje";
  return journey.destination ? `${journey.line} ${journey.destination}` : journey.line;
}

function detail({ mode, journey }: VehicleInfo): string {
  return journey ? `${MODE_LABEL[mode]} · ${formatDelay(journey.delaySeconds)}` : MODE_LABEL[mode];
}

/** Line, destination, delay, mode for the clicked vehicle. Hidden when `info` is null. */
export function InfoCard(props: { info: VehicleInfo | null; onClose: () => void }) {
  return (
    <Show when={props.info}>
      {(info) => (
        <aside class="info-card">
          <button onClick={props.onClose} aria-label="Lukk">×</button>
          <h2>{heading(info().journey)}</h2>
          <p>{detail(info())}</p>
        </aside>
      )}
    </Show>
  );
}
