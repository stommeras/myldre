import { Show } from "solid-js";
import type { VehicleInfo } from "../vehicles/store";

/** Line, destination, delay, mode for the clicked vehicle. Hidden when `info` is null. */
export function InfoCard(props: { info: VehicleInfo | null; onClose: () => void }) {
  return (
    <Show when={props.info}>
      {(info) => (
        <aside class="info-card">
          <button onClick={props.onClose} aria-label="Close">×</button>
          {/* TODO: line {info().journey?.line}, destination, formatDelay(delaySeconds), mode. "No journey" when journey is null. */}
          <p>{info().mode}</p>
        </aside>
      )}
    </Show>
  );
}

/** "+3 min", "on time", "-1 min". */
export function formatDelay(seconds: number | null): string {
  throw new Error("not implemented");
}
