# Solar-Hybrid Circadian Curves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add date-aware solar/human circadian curves with a configurable November-through-January hold while preserving fixed curves.

**Architecture:** Keep cyclic shape-preserving interpolation in `house-automation-core`. Add a daemon-side `solar` module that calculates local solar events, maps winter dates, derives daily anchors, and presents fixed and solar curves through one date-aware schedule. Parse approximate location and timezone from strict TOML; production clock uses that timezone.

**Tech Stack:** Rust 2024, serde/TOML, chrono, chrono-tz, Tokio, Cargo, Nix flakes

---

## File map

- Modify `house-automation-core/src/curve.rs`: interpolate CCT in mired and expose unchanged curve API.
- Modify `house-automation-core/src/state.rs`: expose validated `LocalDate` components.
- Create `house-automationd/src/solar.rs`: solar events, winter mapping, daily anchor generation, and `CircadianSchedule`.
- Modify `house-automationd/src/lib.rs`: export the new module.
- Modify `house-automationd/src/config.rs`: strict location and fixed/solar curve parsing.
- Modify `house-automationd/src/scheduler.rs`: use configured IANA timezone.
- Modify `house-automationd/src/runtime.rs`: sample schedules with local date and start configured clock.
- Modify `house-automationd/tests/config.rs`: schema and validation coverage.
- Modify `house-automationd/tests/runtime.rs`: date-sensitive runtime coverage.
- Modify `house-automationd/tests/scheduler.rs`: configured-timezone coverage.
- Modify `examples/house.toml`: approximate Stockholm location and solar curve example.
- Modify `README.md`: curve model, winter hold, and pin-update documentation.

### Task 1: Mired interpolation and date accessors

**Files:**
- Modify: `house-automation-core/src/curve.rs`
- Modify: `house-automation-core/src/state.rs`

- [ ] **Step 1: Write failing mired interpolation and date accessor tests**

Add a two-anchor assertion using the reciprocal-temperature midpoint and add a
calendar component assertion:

```rust
let expected_kelvin = 1_000_000.0
    / ((1_000_000.0 / 2_700.0 + 1_000_000.0 / 5_100.0) / 2.0);
assert!((noon.color_temperature().get() - expected_kelvin).abs() < 1e-9);

let date = LocalDate::new(2026, 11, 1).unwrap();
assert_eq!((date.year(), date.month(), date.day()), (2026, 11, 1));
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `cargo test -p house-automation-core curve::tests::two_anchors_use_linear_interpolation_in_each_cyclic_segment state::tests::local_dates_expose_validated_components`

Expected: CCT assertion fails with Kelvin midpoint and accessor test fails to compile.

- [ ] **Step 3: Implement mired interpolation and accessors**

Store CCT interpolation values and slopes in mired, converting only at sample:

```rust
let color_temperature_values: Vec<_> = self
    .anchors
    .iter()
    .map(|anchor| 1_000_000.0 / anchor.color_temperature.get())
    .collect();
let color_temperature_mired = interpolate(
    &self.anchors,
    &color_temperature_values,
    &self.color_temperature_slopes,
    time,
);
let color_temperature = 1_000_000.0 / color_temperature_mired;
```

Expose immutable date components:

```rust
pub fn year(self) -> i32 { self.year }
pub fn month(self) -> u8 { self.month }
pub fn day(self) -> u8 { self.day }
```

- [ ] **Step 4: Run focused tests and commit**

Run: `cargo fmt --check && cargo test -p house-automation-core curve state`

Expected: PASS.

Commit: `feat(core): interpolate circadian color in mired`

### Task 2: Solar events and winter-date policy

**Files:**
- Create: `house-automationd/src/solar.rs`
- Modify: `house-automationd/src/lib.rs`

- [ ] **Step 1: Write failing unit tests in `solar.rs`**

Define tests for plausible Stockholm events and cross-year mapping:

```rust
#[test]
fn stockholm_equinox_events_are_plausible() {
    let events = solar_events(date(2026, 3, 20), location(), Stockholm);
    assert!((6 * 60..=7 * 60).contains(&events.sunrise_minutes.unwrap()));
    assert!((11 * 60..=13 * 60).contains(&events.noon_minutes));
    assert!((17 * 60..=19 * 60).contains(&events.sunset_minutes.unwrap()));
}

#[test]
fn cross_year_winter_hold_maps_to_prior_november() {
    let hold = WinterHold::new(month_day(11, 1), month_day(1, 31), month_day(11, 1)).unwrap();
    assert_eq!(hold.effective_date(date(2027, 1, 15)), date(2026, 11, 1));
    assert_eq!(hold.effective_date(date(2027, 2, 1)), date(2027, 2, 1));
}
```

Also cover summer/winter plausibility, invalid month-days, reference outside
hold, and polar `None` sunrise/sunset.

- [ ] **Step 2: Run test and confirm RED**

Run: `cargo test -p house-automationd solar --lib`

Expected: compile failure because module types and functions do not exist.

- [ ] **Step 3: Implement validated policy types and NOAA event math**

Add these public constructors and boundaries:

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Coordinates { latitude: f64, longitude: f64 }

impl Coordinates {
    pub fn new(latitude: f64, longitude: f64) -> Result<Self, SolarError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonthDay { month: u8, day: u8 }

impl MonthDay {
    pub fn new(month: u8, day: u8) -> Result<Self, SolarError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WinterHold { start: MonthDay, end: MonthDay, reference: MonthDay }

impl WinterHold {
    pub fn new(start: MonthDay, end: MonthDay, reference: MonthDay) -> Result<Self, SolarError>;
    pub fn effective_date(self, date: LocalDate) -> LocalDate;
}
```

Use NOAA fractional-year equations for equation-of-time and declination,
official sunrise zenith `90.833°`, longitude, and timezone offset at local noon.
Return `None` for sunrise/sunset when hour-angle cosine lies outside `-1..=1`.

- [ ] **Step 4: Run focused tests and commit**

Run: `cargo fmt --check && cargo test -p house-automationd solar --lib`

Expected: PASS.

Commit: `feat(circadian): calculate local solar events`

### Task 3: Generate daily hybrid curves

**Files:**
- Modify: `house-automationd/src/solar.rs`

- [ ] **Step 1: Write failing generator tests**

Construct a `SolarHybridCurve` for Stockholm, `07:00–23:00`, and assert:

```rust
let november = schedule.generated_curve(date(2026, 11, 1)).unwrap();
let december = schedule.generated_curve(date(2026, 12, 21)).unwrap();
let january = schedule.generated_curve(date(2027, 1, 15)).unwrap();
assert_eq!(november.anchors(), december.anchors());
assert_eq!(november.anchors(), january.anchors());
assert_ne!(november.anchors(), schedule.generated_curve(date(2027, 2, 1)).unwrap().anchors());
```

Sample every five minutes and assert finite bounds, a daytime peak above both
morning and evening, and a color-only transition where brightness remains at
day level while CCT has begun warming.

- [ ] **Step 2: Run test and confirm RED**

Run: `cargo test -p house-automationd solar::tests::winter_hold_keeps_november_curve_through_january --lib`

Expected: compile failure because schedule types do not exist.

- [ ] **Step 3: Implement schedule and deterministic anchor policy**

Add:

```rust
#[derive(Debug, Clone)]
pub enum CircadianSchedule {
    Fixed(CircadianCurve),
    SolarHybrid(SolarHybridCurve),
}

impl CircadianSchedule {
    pub fn sample(&self, date: LocalDate, time: TimeOfDay) -> CurvePoint;
}

#[derive(Debug, Clone)]
pub struct SolarHybridCurve {
    coordinates: Coordinates,
    time_zone: Tz,
    wake_time: TimeOfDay,
    bed_time: TimeOfDay,
    night_brightness: Brightness,
    day_brightness: Brightness,
    night_kelvin: Kelvin,
    day_kelvin: Kelvin,
    winter_hold: Option<WinterHold>,
}
```

Validate at least eight hours between wake and bed and increasing night/day
bounds. Clamp solar noon inside the awake window. Generate unique anchors for
wake, morning-ready, noon, color-evening, brightness-evening, and bed. Blend
intermediate Kelvin values in mired. Missing sunrise/sunset use wake/bed
fallbacks.

- [ ] **Step 4: Run tests and commit**

Run: `cargo fmt --check && cargo test -p house-automationd solar --lib`

Expected: PASS.

Commit: `feat(circadian): derive hybrid daily curves`

### Task 4: Strict TOML configuration

**Files:**
- Modify: `house-automationd/src/config.rs`
- Modify: `house-automationd/tests/config.rs`
- Modify: `examples/house.toml`

- [ ] **Step 1: Add failing configuration tests**

Add approximate location plus an unused solar example curve. Assert parsing
produces `Europe/Stockholm`; add rejection cases for missing location, latitude
outside `-90..=90`, longitude outside `-180..=180`, unknown timezone, fixed
curve carrying solar fields, solar curve carrying anchors, invalid `MM-DD`,
short wake/bed interval, and winter reference outside hold.

```rust
let parts = ValidatedConfig::parse(EXAMPLE).unwrap().into_runtime_parts();
assert_eq!(parts.time_zone.name(), "Europe/Stockholm");
assert!(reject(&without_location).contains("location"));
assert!(reject(&bad_zone).contains("IANA timezone"));
```

- [ ] **Step 2: Run config tests and confirm RED**

Run: `cargo test -p house-automationd --test config`

Expected: parse failure on new `location`, then missing runtime schedule types.

- [ ] **Step 3: Implement raw schema and validation**

Add optional `RawLocation`, `RawCurveKind` defaulting to `fixed`, optional
fixed/solar fields, and `RawWinterHold`. Parse `Tz` using `str::parse`. Change
`RuntimeConfigParts.curves` to `BTreeMap<ScopeId, CircadianSchedule>` and add
`time_zone: Tz`. `validate_curves` must enforce exclusive fields and require
location only when at least one curve is solar.

Use these TOML values in `examples/house.toml`:

```toml
[location]
latitude = 59.3
longitude = 18.1
time_zone = "Europe/Stockholm"

[[curves]]
id = "solar-day"
kind = "solar_hybrid"
wake_time = "07:00"
bed_time = "23:00"
night_brightness = 0.10
day_brightness = 1.00
night_color_temperature_kelvin = 2200
day_color_temperature_kelvin = 5000
winter_hold = { start = "11-01", end = "01-31", reference = "11-01" }
```

- [ ] **Step 4: Run config tests and commit**

Run: `cargo fmt --check && cargo test -p house-automationd --test config`

Expected: PASS.

Commit: `feat(config): validate solar hybrid curves`

### Task 5: Configured timezone and date-aware runtime

**Files:**
- Modify: `house-automationd/src/scheduler.rs`
- Modify: `house-automationd/src/runtime.rs`
- Modify: `house-automationd/tests/scheduler.rs`
- Modify: `house-automationd/tests/runtime.rs`

- [ ] **Step 1: Write failing scheduler and runtime tests**

Add a clock test showing a supplied timezone is stored for system wall samples.
Add a runtime test initializing two engines with the solar curve at the same
clock time on November 1 and February 1; assert their composed CCT or brightness
differs. Add December/January assertions matching November under the hold.

- [ ] **Step 2: Run tests and confirm RED**

Run: `cargo test -p house-automationd --test scheduler --test runtime`

Expected: compile errors at date-aware schedule sampling and configured clock constructor.

- [ ] **Step 3: Wire timezone and local date through runtime**

Replace production constructor with:

```rust
pub fn now(time_zone: Tz) -> Self {
    Self {
        wall_source: WallSource::System(time_zone),
        monotonic_origin: tokio::time::Instant::now(),
    }
}
```

Build it before moving config parts:

```rust
let time_zone = parts.time_zone;
let clock = TokioClock::now(time_zone);
let engine = HouseEngine::initialize(parts, persisted, clock.sample().runtime)?;
```

Change owner sampling to:

```rust
.sample(now.local_date, now.local_time)
```

- [ ] **Step 4: Run focused tests and commit**

Run: `cargo fmt --check && cargo test -p house-automationd --test scheduler --test runtime`

Expected: PASS.

Commit: `feat(runtime): sample date-aware circadian schedules`

### Task 6: Documentation and full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document behavior and pin flow**

Document fixed versus solar curves, approximate committed coordinates,
Nov-1-through-Jan-31 hold, mired interpolation, and deliberate pin updates:

```text
smarthome PR merge -> exact commit in nixos-config flake.nix
-> nix flake lock --update-input smarthome -> host checks -> nixos-config PR
-> human merge -> home-server pull deployment
```

State explicitly that `smarthome` does not import or depend on `nixos-config`;
the host repository consumes the application flake.

- [ ] **Step 2: Run fast documentation and Rust gates**

Run:

```console
git diff --check
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace
```

Expected: all commands exit 0.

- [ ] **Step 3: Run full reproducible Nix gate**

Run: `nix flake check -L`

Expected: Rust checks, package, NixOS module VM, and simulated-house check pass.

- [ ] **Step 4: Commit final docs and verification fixes**

Commit: `docs: explain solar circadian configuration`

- [ ] **Step 5: Review, push, and open PR**

Write `/tmp/smarthome-solar-pr.md` with this body:

```markdown
## Summary

- derive smooth daily circadian curves from local solar events and wake/bed policy
- hold the November 1 profile through December and January
- configure approximate location and IANA timezone declaratively
- preserve fixed-anchor curves and interpolate color temperature in mired

## Verification

- `cargo fmt --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `cargo build --workspace`
- `nix flake check -L`
```

Run:

```console
git status --short
git log --oneline origin/main..HEAD
git push -u origin feat/solar-circadian
gh pr create --base main --head feat/solar-circadian --title "Add solar-hybrid circadian curves" --body-file /tmp/smarthome-solar-pr.md
```

Expected: clean worktree, coherent commits, and open application PR with CI running.
