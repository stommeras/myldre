# Myldre

A 3D map of Norway where public transport vehicles move on real terrain. Buses, coaches, ferries and trains glide along their routes, using positions from the [Entur Vehicle Positions API](https://developer.entur.no/docs/open-services/vehicle-positions).

The map opens on all of Norway and plays a recording sped up, so a whole morning rush fits in a few minutes. Zoomed out, each vehicle is a glowing dot with a fading trail, colored by mode. Zoom into a city and the view tilts, and the dots become small low-poly models for each mode. Click a vehicle to see its line, destination, delay and mode.

This is a side project for fun, and a place to try SolidJS, MapLibre, deck.gl and later Rust.

See [PLAN.md](PLAN.md) for decisions and milestones, [GLOSSARY.md](GLOSSARY.md) for terms, and [SPIKES.md](SPIKES.md) for the measurements behind them.

## Run it

You need Node 24 or later and pnpm.

```sh
pnpm install
pnpm dev
```

Replay reads recordings from `public/recordings/`, which git ignores. Record one before the first run:

```sh
node scripts/record.ts 30 public/recordings/2026-11-03-evening.ndjson.gz
```

The app loads `2026-11-03-evening` by default. These URL parameters change what it shows:

- `?recording=<name>` plays `public/recordings/<name>.ndjson.gz` instead.
- `?speed=<n>` starts at 1, 10, 30, 60 or 120 times real time. The default is 60.
- `?live` shows live vehicles in Bergen instead of a replay. It stays as a debug view until the relay (M4) makes live a replay at 1x.

`pnpm test` runs the tests. `pnpm models` rebuilds the vehicle models in `public/models/`.

## Data

Vehicle positions and route shapes come from Entur under the [Norwegian Licence for Open Government Data (NLOD)](https://data.norge.no/nlod/en/2.0). Map data comes from [OpenFreeMap](https://openfreemap.org) and OpenStreetMap contributors. Terrain comes from the AWS Terrarium elevation tiles.
