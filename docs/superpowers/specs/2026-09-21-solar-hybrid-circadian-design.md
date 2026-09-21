# Solar-Hybrid Circadian Curve Design

## Goal

Add a reusable circadian mode that follows local solar time without shortening
the artificial-light day through the darkest part of winter. Keep existing
fixed-anchor curves compatible. Store approximate household coordinates and
timezone in declarative host configuration, not application code.

## Evidence and selected approach

Common adaptive-lighting systems use sunrise/sunset or solar elevation plus a
human wake/sleep schedule. They do not use one raw 24-hour sine wave. Outdoor
light changes with solar elevation, while useful indoor lighting also needs a
stable morning start and a warm evening.

Three approaches were considered:

1. Generate daily solar-event anchors and feed them to the existing cyclic,
   shape-preserving cubic interpolator. This is selected: it preserves the
   tested curve and freeze/follow semantics, stays easy to inspect, and allows
   brightness and color temperature to turn at different times.
2. Evaluate an analytic solar-elevation function on every tick. This is more
   physically literal but harder to tune as an indoor-lighting policy and
   duplicates the existing interpolation boundary.
3. Commit twelve monthly fixed curves. This is simple but introduces visible
   month-boundary jumps and makes location changes laborious.

The existing interpolator is monotone only within each adjacent anchor pair;
the complete daily curve rises and falls. It remains in place. Color
temperature interpolation changes from Kelvin to reciprocal megakelvin
(`mired`) so transitions track how lamps and human color perception are
normally controlled.

## Configuration

Solar mode requires one top-level location:

```toml
[location]
latitude = 59.3
longitude = 18.1
time_zone = "Europe/Stockholm"
```

Coordinates are intentionally approximate and non-secret. `time_zone` must be
an IANA timezone known to `chrono-tz`; it drives both wall-clock scheduling and
the UTC offset used for solar events. Fixed-only configurations may omit the
table and retain the existing Stockholm clock default for compatibility.

A solar curve uses explicit human and output bounds:

```toml
[[curves]]
id = "default-day"
kind = "solar_hybrid"
wake_time = "07:00"
bed_time = "23:00"
night_brightness = 0.10
day_brightness = 1.00
night_color_temperature_kelvin = 2200
day_color_temperature_kelvin = 5000
winter_hold = { start = "11-01", end = "01-31", reference = "11-01" }
```

Existing curves omit `kind` and continue to use `anchors`. Strict parsing
rejects mixed fixed/solar fields, invalid coordinates, invalid dates, sleep
windows too short to form a useful curve, and a solar curve without location.

The first implementation intentionally fixes the internal transition offsets:

- morning-ready: later of `wake + 90 min` and `sunrise + 45 min`, clamped
  before solar noon;
- daytime peak: local solar noon;
- warm-evening: `sunset + 90 min`, clamped between solar noon and
  `bed - 90 min`;
- bedtime and overnight: configured night output.

Derived intermediate values are deterministic fractions between configured
night and day endpoints. Extra anchors may hold one dimension while the other
changes, allowing color temperature to warm before brightness reaches its
night level. These policy constants stay private until real household use
shows a need to tune them.

## Winter hold

Before solar calculation, the requested local date is mapped through the
configured hold. For the default cross-year interval, every date from November
1 through January 31 uses November 1 of the relevant winter season. November's
longer artificial-light cycle therefore remains stable through December and
January instead of following the solstice contraction. February 1 resumes the
real seasonal date.

`start`, `end`, and `reference` are month-day values, making the policy
declarative. The reference must belong to the hold interval. Leap years and
cross-year intervals are deterministic. If polar conditions have no sunrise or
sunset, the missing event falls back to the configured wake or bed boundary;
solar noon remains calculable. Output therefore stays finite and useful without
inventing a geographic event.

## Runtime boundaries

Validated runtime curves become schedules with a date-aware sample operation:

- fixed schedule: sample the existing `CircadianCurve` using local time;
- solar schedule: derive daily anchors from local date, coordinates,
  timezone offset, wake/bed policy, and winter mapping, then sample the same
  curve implementation.

Solar schedules retain the validated `chrono-tz` timezone and obtain the UTC
offset for the effective solar date at local noon. `RuntimeInstant` continues
to carry local date, local time, and monotonic time. Production clock uses the
same configured timezone. Tests inject deterministic dates/times; no network,
geocoding, system timezone lookup, or wall-clock sleep enters curve tests.

## Validation and tests

Unit tests cover:

- Stockholm equinox and solstice sunrise/noon/sunset plausibility;
- a daily curve that rises, peaks, and falls without segment overshoot;
- brightness and color temperature turning at different times;
- mired rather than Kelvin interpolation;
- identical generated anchors for November 1, December, and January under the
  winter hold, with February using its real date;
- cross-year hold mapping and invalid configuration rejection;
- backward-compatible fixed-anchor configuration;
- timezone/DST offsets coming from configured IANA timezone;
- runtime recomputation using local date as well as local time.

Workspace Rust gates and the full Nix flake check remain required. A later
`nixos-config` PR updates the exact `smarthome` commit pin and commits the
approximate household location alongside host-owned topology.
