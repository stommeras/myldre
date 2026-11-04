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

/** Line, destination, delay, mode for the clicked vehicle. Hidden when `info` is null. */
export function InfoCard(props: { info: VehicleInfo | null; onClose: () => void }) {
  return (
    <Show when={props.info}>
      {(info) => (
        <aside class="info-card">
          <button onClick={props.onClose} aria-label="Lukk">×</button>
          <Show when={info().journey} fallback={<><h2>Ikke i trafikk</h2><p>{MODE_LABEL[info().mode]}</p></>}>
            {(journey) => (
              <>
                <h2>{journey().destination ? `${journey().line} ${journey().destination}` : journey().line}</h2>
                <p>{MODE_LABEL[info().mode]} · {formatDelay(journey().delaySeconds)}</p>
              </>
            )}
          </Show>
        </aside>
      )}
    </Show>
  );
}
