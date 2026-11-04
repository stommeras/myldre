import { Show } from "solid-js";
import type { Playback } from "../vehicles/replay";

export function LoadStatus(props: { playback: Playback | null }) {
  const failed = () => {
    const p = props.playback;
    return p?.kind === "failed" ? p : null;
  };
  return (
    <Show when={props.playback?.kind === "loading" || failed()}>
      <div class="load-status" role={failed() ? "alert" : "status"}>
        <Show when={failed()} fallback="Laster opptak…">
          {(f) => (
            <>
              <Show when={f().missing} fallback={<>Kunne ikke laste opptaket {f().name}</>}>
                Fant ikke opptaket {f().name}
                <br />
                <code>node scripts/record.ts 130 public/recordings/{f().name}.ndjson.gz</code>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}
