import { Show } from "solid-js";
import type { VehicleInfo } from "../vehicles/store";
import { formatDelay } from "./formatDelay";

/** Line, destination, delay, mode for the clicked vehicle. Hidden when `info` is null. */
export function InfoCard(props: { info: VehicleInfo | null; onClose: () => void }) {
  return (
    <Show when={props.info}>
      {(info) => (
        <aside class="info-card">
          <button onClick={props.onClose} aria-label="Close">×</button>
          <Show when={info().journey} fallback={<><h2>No journey</h2><p>{info().mode}</p></>}>
            {(journey) => (
              <>
                <h2>{journey().destination ? `${journey().line} ${journey().destination}` : journey().line}</h2>
                <p>{info().mode} · {formatDelay(journey().delaySeconds)}</p>
              </>
            )}
          </Show>
        </aside>
      )}
    </Show>
  );
}
