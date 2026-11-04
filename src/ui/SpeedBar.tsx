import { For } from "solid-js";

export const SPEEDS = [1, 10, 30, 60, 120] as const;

export function SpeedBar(props: { speed: number; onSpeed: (speed: number) => void }) {
  return (
    <nav class="speed-bar" aria-label="Avspillingsfart">
      <For each={SPEEDS}>
        {(s) => (
          <button classList={{ on: props.speed === s }} aria-pressed={props.speed === s} onClick={() => props.onSpeed(s)}>
            {s}x
          </button>
        )}
      </For>
    </nav>
  );
}
