use std::{
    collections::BTreeMap,
    error::Error,
    fmt::{self, Display},
};

use serde::{Deserialize, Serialize};

use crate::{
    curve::{CurvePoint, TimeOfDay},
    value::{Brightness, Kelvin, KelvinRange, LightTarget, ValueError},
};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ScopeId(String);

impl ScopeId {
    pub fn new(value: impl Into<String>) -> Result<Self, StateError> {
        validate_identifier(value.into()).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ScopeId {
    type Error = StateError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<ScopeId> for String {
    fn from(value: ScopeId) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ControlId(String);

impl ControlId {
    pub fn new(value: impl Into<String>) -> Result<Self, StateError> {
        validate_identifier(value.into()).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ControlId {
    type Error = StateError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<ControlId> for String {
    fn from(value: ControlId) -> Self {
        value.0
    }
}

fn validate_identifier(value: String) -> Result<String, StateError> {
    if value.is_empty() || value.trim() != value {
        return Err(StateError::InvalidIdentifier);
    }

    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Room(ScopeId),
    Floor(ScopeId),
    House,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "LocalDateRepr", into = "LocalDateRepr")]
pub struct LocalDate {
    year: i32,
    month: u8,
    day: u8,
}

impl LocalDate {
    pub fn new(year: i32, month: u8, day: u8) -> Result<Self, StateError> {
        let max_day = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if is_leap_year(year) => 29,
            2 => 28,
            _ => return Err(StateError::InvalidLocalDate),
        };
        if day == 0 || day > max_day {
            return Err(StateError::InvalidLocalDate);
        }

        Ok(Self { year, month, day })
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[derive(Serialize, Deserialize)]
struct LocalDateRepr {
    year: i32,
    month: u8,
    day: u8,
}

impl TryFrom<LocalDateRepr> for LocalDate {
    type Error = StateError;

    fn try_from(value: LocalDateRepr) -> Result<Self, Self::Error> {
        Self::new(value.year, value.month, value.day)
    }
}

impl From<LocalDate> for LocalDateRepr {
    fn from(value: LocalDate) -> Self {
        Self {
            year: value.year,
            month: value.month,
            day: value.day,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct MonotonicTime(f64);

impl MonotonicTime {
    pub fn from_seconds(seconds: f64) -> Result<Self, StateError> {
        if !seconds.is_finite() {
            return Err(StateError::NonFinite);
        }
        if seconds < 0.0 {
            return Err(StateError::NegativeMonotonicTime);
        }
        Ok(Self(seconds))
    }
}

impl TryFrom<f64> for MonotonicTime {
    type Error = StateError;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Self::from_seconds(value)
    }
}

impl From<MonotonicTime> for f64 {
    fn from(value: MonotonicTime) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct ConvergenceDuration(f64);

impl ConvergenceDuration {
    pub fn from_seconds(seconds: f64) -> Result<Self, StateError> {
        if !seconds.is_finite() {
            return Err(StateError::NonFinite);
        }
        if seconds <= 0.0 {
            return Err(StateError::NonPositiveConvergenceDuration);
        }
        Ok(Self(seconds))
    }
}

impl TryFrom<f64> for ConvergenceDuration {
    type Error = StateError;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Self::from_seconds(value)
    }
}

impl From<ConvergenceDuration> for f64 {
    fn from(value: ConvergenceDuration) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "UserOffsetsRepr", into = "UserOffsetsRepr")]
pub struct UserOffsets {
    brightness: f64,
    color_temperature_kelvin: f64,
}

impl UserOffsets {
    pub fn new(brightness: f64, color_temperature_kelvin: f64) -> Result<Self, StateError> {
        if !brightness.is_finite() || !color_temperature_kelvin.is_finite() {
            return Err(StateError::NonFinite);
        }

        Ok(Self {
            brightness,
            color_temperature_kelvin,
        })
    }
}

impl Default for UserOffsets {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            color_temperature_kelvin: 0.0,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct UserOffsetsRepr {
    brightness: f64,
    color_temperature_kelvin: f64,
}

impl TryFrom<UserOffsetsRepr> for UserOffsets {
    type Error = StateError;

    fn try_from(value: UserOffsetsRepr) -> Result<Self, Self::Error> {
        Self::new(value.brightness, value.color_temperature_kelvin)
    }
}

impl From<UserOffsets> for UserOffsetsRepr {
    fn from(value: UserOffsets) -> Self {
        Self {
            brightness: value.brightness,
            color_temperature_kelvin: value.color_temperature_kelvin,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CircadianBaseline {
    brightness: Brightness,
    color_temperature: Kelvin,
}

impl CircadianBaseline {
    fn interpolate(self, target: Self, progress: f64) -> Self {
        let interpolate = |from: f64, to: f64| from + progress * (to - from);
        Self {
            brightness: Brightness::clamped(interpolate(
                self.brightness.get(),
                target.brightness.get(),
            ))
            .expect("validated circadian values produce finite brightness"),
            color_temperature: Kelvin::new(interpolate(
                self.color_temperature.get(),
                target.color_temperature.get(),
            ))
            .expect("positive circadian values remain positive during interpolation"),
        }
    }
}

impl From<CurvePoint> for CircadianBaseline {
    fn from(value: CurvePoint) -> Self {
        Self {
            brightness: value.brightness(),
            color_temperature: value.color_temperature(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum CurveMode {
    Follow,
    Frozen {
        baseline: CircadianBaseline,
    },
    Converging {
        from: CircadianBaseline,
        started_at: MonotonicTime,
        duration: ConvergenceDuration,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlState {
    scope: Scope,
    on: bool,
    offsets: UserOffsets,
    mode: CurveMode,
}

impl ControlState {
    pub fn new(scope: Scope, on: bool) -> Self {
        Self {
            scope,
            on,
            offsets: UserOffsets::default(),
            mode: CurveMode::Follow,
        }
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    pub fn offsets(&self) -> UserOffsets {
        self.offsets
    }

    pub fn set_offsets(&mut self, offsets: UserOffsets) {
        self.offsets = offsets;
    }

    pub fn mode(&self) -> &CurveMode {
        &self.mode
    }

    pub fn freeze(&mut self, live_curve: CurvePoint) {
        self.mode = CurveMode::Frozen {
            baseline: live_curve.into(),
        };
    }

    pub fn unfreeze(&mut self, started_at: MonotonicTime, duration: ConvergenceDuration) {
        if let CurveMode::Frozen { baseline } = self.mode {
            self.mode = CurveMode::Converging {
                from: baseline,
                started_at,
                duration,
            };
        }
    }

    pub fn compose_target(
        &mut self,
        live_curve: CurvePoint,
        now: MonotonicTime,
        color_temperature_range: KelvinRange,
    ) -> Result<LightTarget, StateError> {
        let live_baseline = CircadianBaseline::from(live_curve);
        let baseline = match self.mode {
            CurveMode::Follow => live_baseline,
            CurveMode::Frozen { baseline } => baseline,
            CurveMode::Converging {
                from,
                started_at,
                duration,
            } => {
                if now < started_at {
                    return Err(StateError::MonotonicClockRegressed);
                }
                let progress = (now.0 - started_at.0) / duration.0;
                if progress >= 1.0 {
                    self.mode = CurveMode::Follow;
                    live_baseline
                } else {
                    from.interpolate(live_baseline, progress)
                }
            }
        };

        Ok(LightTarget {
            on: self.on,
            brightness: Some(
                baseline
                    .brightness
                    .with_offset(self.offsets.brightness)
                    .map_err(StateError::InvalidValue)?,
            ),
            color_temperature: Some(
                color_temperature_range
                    .with_offset(
                        baseline.color_temperature,
                        self.offsets.color_temperature_kelvin,
                    )
                    .map_err(StateError::InvalidValue)?,
            ),
            color: None,
            transition_ms: None,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AutomationState {
    controls: BTreeMap<ControlId, ControlState>,
    last_reset_date: Option<LocalDate>,
}

impl AutomationState {
    pub fn with_last_reset_date(last_reset_date: LocalDate) -> Self {
        Self {
            controls: BTreeMap::new(),
            last_reset_date: Some(last_reset_date),
        }
    }

    pub fn insert(&mut self, control_id: ControlId, state: ControlState) -> Option<ControlState> {
        self.controls.insert(control_id, state)
    }

    pub fn control(&self, control_id: &ControlId) -> Option<&ControlState> {
        self.controls.get(control_id)
    }

    pub fn last_reset_date(&self) -> Option<LocalDate> {
        self.last_reset_date
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reset_circadian_if_due(
        &mut self,
        local_date: LocalDate,
        local_time: TimeOfDay,
        reset_time: TimeOfDay,
        monotonic_now: MonotonicTime,
        convergence_duration: ConvergenceDuration,
        live_baselines: &BTreeMap<Scope, CurvePoint>,
    ) -> Result<bool, StateError> {
        if local_time < reset_time || self.last_reset_date.is_some_and(|date| date >= local_date) {
            return Ok(false);
        }

        for control in self.controls.values() {
            if matches!(control.mode, CurveMode::Frozen { .. })
                && !live_baselines.contains_key(control.scope())
            {
                return Err(StateError::MissingLiveBaseline(control.scope().clone()));
            }
        }

        let mut next = self.clone();
        for control in next.controls.values_mut() {
            control.unfreeze(monotonic_now, convergence_duration);
        }
        next.last_reset_date = Some(local_date);
        *self = next;
        Ok(true)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StateError {
    InvalidIdentifier,
    InvalidLocalDate,
    NonFinite,
    NegativeMonotonicTime,
    NonPositiveConvergenceDuration,
    MonotonicClockRegressed,
    MissingLiveBaseline(Scope),
    InvalidValue(ValueError),
}

impl Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier => formatter.write_str(
                "identifier must be nonempty and have no leading or trailing whitespace",
            ),
            Self::InvalidLocalDate => formatter.write_str("invalid Gregorian local date"),
            Self::NonFinite => formatter.write_str("value must be finite"),
            Self::NegativeMonotonicTime => {
                formatter.write_str("monotonic time must not be negative")
            }
            Self::NonPositiveConvergenceDuration => {
                formatter.write_str("convergence duration must be greater than zero")
            }
            Self::MonotonicClockRegressed => formatter.write_str("monotonic clock regressed"),
            Self::MissingLiveBaseline(scope) => {
                write!(
                    formatter,
                    "missing live circadian baseline for scope {scope:?}"
                )
            }
            Self::InvalidValue(error) => write!(formatter, "invalid composed value: {error}"),
        }
    }
}

impl Error for StateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidValue(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::{Serialize, de::DeserializeOwned};

    use crate::{
        curve::{CircadianCurve, CurveAnchor, CurvePoint, TimeOfDay},
        value::{Brightness, KelvinRange},
    };

    use super::{
        AutomationState, ControlId, ControlState, ConvergenceDuration, CurveMode, LocalDate,
        MonotonicTime, Scope, ScopeId, StateError, UserOffsets,
    };

    fn time(hour: u8) -> TimeOfDay {
        TimeOfDay::from_hms(hour, 0, 0).unwrap()
    }

    fn point(brightness: f64, kelvin: f64) -> CurvePoint {
        let anchor = |hour| {
            CurveAnchor::new(time(hour), Brightness::new(brightness).unwrap(), kelvin).unwrap()
        };
        CircadianCurve::new(vec![anchor(0), anchor(12)])
            .unwrap()
            .sample(time(0))
    }

    fn room(name: &str) -> Scope {
        Scope::Room(ScopeId::new(name).unwrap())
    }

    fn control(scope: Scope, on: bool) -> ControlState {
        ControlState::new(scope, on)
    }

    fn assert_json_round_trip<T>(value: &T)
    where
        T: Serialize + DeserializeOwned + std::fmt::Debug + PartialEq,
    {
        let encoded = serde_json::to_string(value).unwrap();
        assert_eq!(&serde_json::from_str::<T>(&encoded).unwrap(), value);
    }

    #[test]
    fn scope_and_control_ids_are_config_driven_and_nonempty() {
        assert_eq!(ScopeId::new("kitchen").unwrap().as_str(), "kitchen");
        assert_eq!(
            ControlId::new("kitchen_remote").unwrap().as_str(),
            "kitchen_remote"
        );

        for invalid in ["", "   ", " leading", "trailing "] {
            assert!(ScopeId::new(invalid).is_err(), "accepted {invalid:?}");
            assert!(ControlId::new(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn room_floor_and_house_scopes_round_trip_without_vendor_data() {
        let scopes = [
            Scope::Room(ScopeId::new("kitchen").unwrap()),
            Scope::Floor(ScopeId::new("ground").unwrap()),
            Scope::House,
        ];

        for scope in scopes {
            assert_json_round_trip(&scope);
        }
    }

    #[test]
    fn local_dates_validate_calendar_boundaries() {
        assert!(LocalDate::new(2024, 2, 29).is_ok());
        assert!(LocalDate::new(2026, 2, 29).is_err());
        assert!(LocalDate::new(2026, 0, 1).is_err());
        assert!(LocalDate::new(2026, 13, 1).is_err());
        assert!(LocalDate::new(2026, 4, 31).is_err());
    }

    #[test]
    fn offsets_and_convergence_inputs_reject_non_finite_values() {
        for invalid in [f64::NAN, f64::NEG_INFINITY, f64::INFINITY] {
            assert!(UserOffsets::new(invalid, 0.0).is_err());
            assert!(UserOffsets::new(0.0, invalid).is_err());
            assert!(ConvergenceDuration::from_seconds(invalid).is_err());
            assert!(MonotonicTime::from_seconds(invalid).is_err());
        }
        assert!(ConvergenceDuration::from_seconds(0.0).is_err());
        assert!(ConvergenceDuration::from_seconds(-1.0).is_err());
        assert!(MonotonicTime::from_seconds(-1.0).is_err());
    }

    #[test]
    fn freeze_captures_baseline_and_offsets_still_compose() {
        let mut state = control(room("kitchen"), false);
        state.set_offsets(UserOffsets::new(0.15, -300.0).unwrap());
        state.freeze(point(0.45, 2_700.0));

        let target = state
            .compose_target(
                point(0.2, 4_000.0),
                MonotonicTime::from_seconds(100.0).unwrap(),
                KelvinRange::new(2_200.0, 6_500.0).unwrap(),
            )
            .unwrap();

        assert!(!target.on);
        assert!((target.brightness.unwrap().get() - 0.6).abs() < 1e-12);
        assert_eq!(target.color_temperature.unwrap().get(), 2_400.0);
        assert!(matches!(state.mode(), CurveMode::Frozen { .. }));
    }

    #[test]
    fn composition_clamps_offsets_after_selecting_baseline() {
        let mut state = control(room("kitchen"), true);
        state.set_offsets(UserOffsets::new(0.8, -2_000.0).unwrap());

        let target = state
            .compose_target(
                point(0.5, 3_000.0),
                MonotonicTime::from_seconds(0.0).unwrap(),
                KelvinRange::new(2_200.0, 6_500.0).unwrap(),
            )
            .unwrap();

        assert!(target.on);
        assert_eq!(target.brightness.unwrap().get(), 1.0);
        assert_eq!(target.color_temperature.unwrap().get(), 2_200.0);
    }

    #[test]
    fn unfreeze_converges_from_frozen_baseline_then_follows_live_curve() {
        let mut state = control(room("kitchen"), true);
        state.freeze(point(0.4, 2_700.0));
        state.unfreeze(
            MonotonicTime::from_seconds(10.0).unwrap(),
            ConvergenceDuration::from_seconds(10.0).unwrap(),
        );

        let halfway = state
            .compose_target(
                point(0.8, 5_000.0),
                MonotonicTime::from_seconds(15.0).unwrap(),
                KelvinRange::new(2_000.0, 6_500.0).unwrap(),
            )
            .unwrap();
        assert!((halfway.brightness.unwrap().get() - 0.6).abs() < 1e-12);
        assert_eq!(halfway.color_temperature.unwrap().get(), 3_850.0);
        assert!(matches!(state.mode(), CurveMode::Converging { .. }));

        let followed = state
            .compose_target(
                point(0.7, 4_500.0),
                MonotonicTime::from_seconds(20.0).unwrap(),
                KelvinRange::new(2_000.0, 6_500.0).unwrap(),
            )
            .unwrap();
        assert_eq!(followed.brightness.unwrap().get(), 0.7);
        assert_eq!(followed.color_temperature.unwrap().get(), 4_500.0);
        assert_eq!(state.mode(), &CurveMode::Follow);
    }

    #[test]
    fn convergence_rejects_a_monotonic_clock_regression() {
        let mut state = control(room("kitchen"), true);
        state.freeze(point(0.4, 2_700.0));
        state.unfreeze(
            MonotonicTime::from_seconds(10.0).unwrap(),
            ConvergenceDuration::from_seconds(10.0).unwrap(),
        );

        assert_eq!(
            state.compose_target(
                point(0.8, 5_000.0),
                MonotonicTime::from_seconds(9.0).unwrap(),
                KelvinRange::new(2_000.0, 6_500.0).unwrap(),
            ),
            Err(StateError::MonotonicClockRegressed)
        );
    }

    #[test]
    fn nightly_reset_at_four_unfreezes_every_control_atomically() {
        let kitchen = room("kitchen");
        let bedroom = room("bedroom");
        let floor = Scope::Floor(ScopeId::new("ground").unwrap());
        let mut state = AutomationState::default();

        let mut kitchen_control = control(kitchen.clone(), false);
        kitchen_control.set_offsets(UserOffsets::new(0.1, 100.0).unwrap());
        kitchen_control.freeze(point(0.4, 2_700.0));
        let mut bedroom_control = control(bedroom.clone(), true);
        bedroom_control.freeze(point(0.3, 2_500.0));
        state.insert(ControlId::new("kitchen_remote").unwrap(), kitchen_control);
        state.insert(ControlId::new("bedroom_remote").unwrap(), bedroom_control);
        state.insert(
            ControlId::new("floor_panel").unwrap(),
            control(floor.clone(), true),
        );

        let mut live = BTreeMap::new();
        live.insert(kitchen, point(0.2, 3_500.0));
        live.insert(bedroom, point(0.2, 3_500.0));
        live.insert(floor, point(0.2, 3_500.0));
        let date = LocalDate::new(2026, 9, 13).unwrap();

        assert!(
            state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(4, 0, 0).unwrap(),
                    TimeOfDay::from_hms(4, 0, 0).unwrap(),
                    MonotonicTime::from_seconds(50.0).unwrap(),
                    ConvergenceDuration::from_seconds(20.0).unwrap(),
                    &live,
                )
                .unwrap()
        );

        assert!(matches!(
            state
                .control(&ControlId::new("kitchen_remote").unwrap())
                .unwrap()
                .mode(),
            CurveMode::Converging { .. }
        ));
        assert!(matches!(
            state
                .control(&ControlId::new("bedroom_remote").unwrap())
                .unwrap()
                .mode(),
            CurveMode::Converging { .. }
        ));
        assert_eq!(
            state
                .control(&ControlId::new("floor_panel").unwrap())
                .unwrap()
                .mode(),
            &CurveMode::Follow
        );
        assert_eq!(state.last_reset_date(), Some(date));
        let kitchen_after = state
            .control(&ControlId::new("kitchen_remote").unwrap())
            .unwrap();
        assert!(!kitchen_after.is_on());
        assert_eq!(
            kitchen_after.offsets(),
            UserOffsets::new(0.1, 100.0).unwrap()
        );
    }

    #[test]
    fn missing_live_scope_leaves_global_reset_state_unchanged() {
        let mut state = AutomationState::default();
        let mut kitchen = control(room("kitchen"), true);
        kitchen.freeze(point(0.4, 2_700.0));
        state.insert(ControlId::new("kitchen_remote").unwrap(), kitchen);
        let before = state.clone();

        let error = state
            .reset_circadian_if_due(
                LocalDate::new(2026, 9, 13).unwrap(),
                TimeOfDay::from_hms(4, 0, 0).unwrap(),
                TimeOfDay::from_hms(4, 0, 0).unwrap(),
                MonotonicTime::from_seconds(50.0).unwrap(),
                ConvergenceDuration::from_seconds(20.0).unwrap(),
                &BTreeMap::new(),
            )
            .unwrap_err();

        assert!(matches!(error, StateError::MissingLiveBaseline(_)));
        assert_eq!(state, before);
    }

    #[test]
    fn reset_before_four_waits_and_repeated_reset_is_idempotent() {
        let kitchen = room("kitchen");
        let mut state = AutomationState::default();
        let mut kitchen_control = control(kitchen.clone(), true);
        kitchen_control.freeze(point(0.4, 2_700.0));
        state.insert(ControlId::new("kitchen_remote").unwrap(), kitchen_control);
        let live = BTreeMap::from([(kitchen, point(0.2, 3_500.0))]);
        let date = LocalDate::new(2026, 9, 13).unwrap();
        let reset_time = TimeOfDay::from_hms(4, 0, 0).unwrap();
        let duration = ConvergenceDuration::from_seconds(20.0).unwrap();

        assert!(
            !state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(3, 59, 59).unwrap(),
                    reset_time,
                    MonotonicTime::from_seconds(10.0).unwrap(),
                    duration,
                    &live,
                )
                .unwrap()
        );
        assert_eq!(state.last_reset_date(), None);
        assert!(matches!(
            state
                .control(&ControlId::new("kitchen_remote").unwrap())
                .unwrap()
                .mode(),
            CurveMode::Frozen { .. }
        ));

        assert!(
            state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(10, 0, 0).unwrap(),
                    reset_time,
                    MonotonicTime::from_seconds(20.0).unwrap(),
                    duration,
                    &live,
                )
                .unwrap()
        );
        let after_first = state.clone();
        assert!(
            !state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(23, 0, 0).unwrap(),
                    reset_time,
                    MonotonicTime::from_seconds(30.0).unwrap(),
                    duration,
                    &live,
                )
                .unwrap()
        );
        assert_eq!(state, after_first);
    }

    #[test]
    fn startup_after_missed_reset_performs_one_global_transition() {
        let kitchen = room("kitchen");
        let mut state = AutomationState::with_last_reset_date(LocalDate::new(2026, 9, 12).unwrap());
        let mut kitchen_control = control(kitchen.clone(), true);
        kitchen_control.freeze(point(0.4, 2_700.0));
        state.insert(ControlId::new("kitchen_remote").unwrap(), kitchen_control);
        let live = BTreeMap::from([(kitchen, point(0.2, 3_500.0))]);
        let date = LocalDate::new(2026, 9, 13).unwrap();

        assert!(
            state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(12, 0, 0).unwrap(),
                    TimeOfDay::from_hms(4, 0, 0).unwrap(),
                    MonotonicTime::from_seconds(1.0).unwrap(),
                    ConvergenceDuration::from_seconds(20.0).unwrap(),
                    &live,
                )
                .unwrap()
        );
        assert_eq!(state.last_reset_date(), Some(date));
        assert!(
            !state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(12, 0, 0).unwrap(),
                    TimeOfDay::from_hms(4, 0, 0).unwrap(),
                    MonotonicTime::from_seconds(2.0).unwrap(),
                    ConvergenceDuration::from_seconds(20.0).unwrap(),
                    &live,
                )
                .unwrap()
        );
    }

    #[test]
    fn persistable_state_round_trips() {
        let mut state = AutomationState::with_last_reset_date(LocalDate::new(2026, 9, 12).unwrap());
        let mut kitchen = control(room("kitchen"), true);
        kitchen.set_offsets(UserOffsets::new(-0.2, 150.0).unwrap());
        kitchen.freeze(point(0.4, 2_700.0));
        state.insert(ControlId::new("kitchen_remote").unwrap(), kitchen);

        assert_json_round_trip(&state);
    }
}
