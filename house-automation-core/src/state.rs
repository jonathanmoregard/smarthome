use std::{
    collections::{BTreeMap, btree_map},
    error::Error,
    fmt::{self, Display},
};

use serde::{Deserialize, Serialize};

use crate::{
    curve::{CurvePoint, TimeOfDay},
    value::{Brightness, Kelvin, KelvinRange, LightTarget, ValueError},
};

const MAX_IDENTIFIER_LENGTH: usize = 64;

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
    let bytes = value.as_bytes();
    let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let valid_inner = |byte: u8| valid_edge(byte) || byte == b'_' || byte == b'-';
    if bytes.is_empty()
        || bytes.len() > MAX_IDENTIFIER_LENGTH
        || !valid_edge(bytes[0])
        || !valid_edge(bytes[bytes.len() - 1])
        || !bytes.iter().copied().all(valid_inner)
    {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeMembership {
    room: ScopeId,
    floor: ScopeId,
}

impl ScopeMembership {
    pub fn new(room: ScopeId, floor: ScopeId) -> Self {
        Self { room, floor }
    }

    pub fn is_in(&self, scope: &Scope) -> bool {
        match scope {
            Scope::Room(room) => room == &self.room,
            Scope::Floor(floor) => floor == &self.floor,
            Scope::House => true,
        }
    }
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
        let max_day = days_in_month(year, month).ok_or(StateError::InvalidLocalDate)?;
        if day == 0 || day > max_day {
            return Err(StateError::InvalidLocalDate);
        }

        Ok(Self { year, month, day })
    }

    fn previous_day(self) -> Result<Self, StateError> {
        if self.day > 1 {
            return Self::new(self.year, self.month, self.day - 1);
        }
        if self.month > 1 {
            let previous_month = self.month - 1;
            let day = days_in_month(self.year, previous_month)
                .expect("month preceding a validated month is valid");
            return Self::new(self.year, previous_month, day);
        }

        let previous_year = self
            .year
            .checked_sub(1)
            .ok_or(StateError::LocalDateOutOfRange)?;
        Self::new(previous_year, 12, 31)
    }
}

fn days_in_month(year: i32, month: u8) -> Option<u8> {
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return None,
    };
    Some(days)
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

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
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

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
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

    pub fn brightness(self) -> f64 {
        self.brightness
    }

    pub fn color_temperature_kelvin(self) -> f64 {
        self.color_temperature_kelvin
    }

    fn adjusted(self, brightness: f64, color_temperature_kelvin: f64) -> Result<Self, StateError> {
        Self::new(
            self.brightness + brightness,
            self.color_temperature_kelvin + color_temperature_kelvin,
        )
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CurveMode {
    Follow,
    Frozen {
        baseline: CircadianBaseline,
    },
    /// Already unfrozen: output approaches current live curve without a visible jump.
    Converging {
        from: CircadianBaseline,
        started_at: MonotonicTime,
        duration: ConvergenceDuration,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurveToggleOutcome {
    Frozen,
    Unfrozen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DailyResetOutcome {
    NotDue,
    MarkerInitialized,
    Unfroze,
}

impl DailyResetOutcome {
    pub fn durable_state_changed(self) -> bool {
        matches!(self, Self::MarkerInitialized | Self::Unfroze)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScopeState {
    on: bool,
    offsets: UserOffsets,
    mode: CurveMode,
}

impl ScopeState {
    pub fn new(on: bool) -> Self {
        Self {
            on,
            offsets: UserOffsets::default(),
            mode: CurveMode::Follow,
        }
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    pub fn offsets(&self) -> UserOffsets {
        self.offsets
    }

    pub fn mode(&self) -> &CurveMode {
        &self.mode
    }

    fn current_baseline(
        &self,
        live_curve: CurvePoint,
        now: MonotonicTime,
    ) -> Result<(CircadianBaseline, bool), StateError> {
        let live = CircadianBaseline::from(live_curve);
        match self.mode {
            CurveMode::Follow => Ok((live, false)),
            CurveMode::Frozen { baseline } => Ok((baseline, false)),
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
                    Ok((live, true))
                } else {
                    Ok((from.interpolate(live, progress), false))
                }
            }
        }
    }

    fn compose(
        &mut self,
        live_curve: CurvePoint,
        now: MonotonicTime,
        color_temperature_range: KelvinRange,
    ) -> Result<LightTarget, StateError> {
        let (baseline, convergence_complete) = self.current_baseline(live_curve, now)?;
        if convergence_complete {
            self.mode = CurveMode::Follow;
        }

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

    fn toggle_curve(
        &mut self,
        live_curve: CurvePoint,
        now: MonotonicTime,
        duration: ConvergenceDuration,
    ) -> Result<CurveToggleOutcome, StateError> {
        match self.mode {
            CurveMode::Follow => {
                self.mode = CurveMode::Frozen {
                    baseline: live_curve.into(),
                };
                Ok(CurveToggleOutcome::Frozen)
            }
            CurveMode::Frozen { baseline } => {
                self.mode = CurveMode::Converging {
                    from: baseline,
                    started_at: now,
                    duration,
                };
                Ok(CurveToggleOutcome::Unfrozen)
            }
            CurveMode::Converging { .. } => {
                let (baseline, _) = self.current_baseline(live_curve, now)?;
                self.mode = CurveMode::Frozen { baseline };
                Ok(CurveToggleOutcome::Frozen)
            }
        }
    }

    fn begin_unfreeze(&mut self, now: MonotonicTime, duration: ConvergenceDuration) {
        // Converging scopes are already unfrozen, so nightly reset does not restart their path.
        if let CurveMode::Frozen { baseline } = self.mode {
            self.mode = CurveMode::Converging {
                from: baseline,
                started_at: now,
                duration,
            };
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlState {
    selected_scope: Scope,
}

impl ControlState {
    pub fn new(selected_scope: Scope) -> Self {
        Self { selected_scope }
    }

    pub fn selected_scope(&self) -> &Scope {
        &self.selected_scope
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AutomationState {
    scopes: BTreeMap<Scope, ScopeState>,
    controls: BTreeMap<ControlId, ControlState>,
    last_reset_date: Option<LocalDate>,
}

impl AutomationState {
    pub fn with_last_reset_date(last_reset_date: LocalDate) -> Self {
        Self {
            scopes: BTreeMap::new(),
            controls: BTreeMap::new(),
            last_reset_date: Some(last_reset_date),
        }
    }

    pub fn insert_scope(&mut self, scope: Scope, state: ScopeState) -> Result<(), StateError> {
        match self.scopes.entry(scope) {
            btree_map::Entry::Vacant(entry) => {
                entry.insert(state);
                Ok(())
            }
            btree_map::Entry::Occupied(entry) => {
                Err(StateError::DuplicateScope(entry.key().clone()))
            }
        }
    }

    pub fn scope_state(&self, scope: &Scope) -> Result<&ScopeState, StateError> {
        self.scopes
            .get(scope)
            .ok_or_else(|| StateError::UnknownScope(scope.clone()))
    }

    pub fn scope_states(&self) -> impl ExactSizeIterator<Item = (&Scope, &ScopeState)> {
        self.scopes.iter()
    }

    fn scope_state_mut(&mut self, scope: &Scope) -> Result<&mut ScopeState, StateError> {
        self.scopes
            .get_mut(scope)
            .ok_or_else(|| StateError::UnknownScope(scope.clone()))
    }

    pub fn insert_control(
        &mut self,
        control_id: ControlId,
        state: ControlState,
    ) -> Result<(), StateError> {
        self.scope_state(state.selected_scope())?;
        match self.controls.entry(control_id) {
            btree_map::Entry::Vacant(entry) => {
                entry.insert(state);
                Ok(())
            }
            btree_map::Entry::Occupied(entry) => {
                Err(StateError::DuplicateControl(entry.key().clone()))
            }
        }
    }

    pub fn control_state(&self, control_id: &ControlId) -> Result<&ControlState, StateError> {
        self.controls
            .get(control_id)
            .ok_or_else(|| StateError::UnknownControl(control_id.clone()))
    }

    pub fn control_states(&self) -> impl ExactSizeIterator<Item = (&ControlId, &ControlState)> {
        self.controls.iter()
    }

    pub fn select_control_scope(
        &mut self,
        control_id: &ControlId,
        scope: Scope,
    ) -> Result<(), StateError> {
        self.scope_state(&scope)?;
        let control = self
            .controls
            .get_mut(control_id)
            .ok_or_else(|| StateError::UnknownControl(control_id.clone()))?;
        control.selected_scope = scope;
        Ok(())
    }

    fn selected_scope(&self, control_id: &ControlId) -> Result<Scope, StateError> {
        Ok(self.control_state(control_id)?.selected_scope().clone())
    }

    pub fn set_scope_power(&mut self, scope: &Scope, on: bool) -> Result<(), StateError> {
        self.scope_state_mut(scope)?.on = on;
        Ok(())
    }

    pub fn toggle_scope_power(&mut self, scope: &Scope) -> Result<bool, StateError> {
        let state = self.scope_state_mut(scope)?;
        state.on = !state.on;
        Ok(state.on)
    }

    pub fn toggle_control_power(&mut self, control_id: &ControlId) -> Result<bool, StateError> {
        let scope = self.selected_scope(control_id)?;
        self.toggle_scope_power(&scope)
    }

    pub fn set_scope_offsets(
        &mut self,
        scope: &Scope,
        offsets: UserOffsets,
    ) -> Result<(), StateError> {
        self.scope_state_mut(scope)?.offsets = offsets;
        Ok(())
    }

    pub fn adjust_scope_offsets(
        &mut self,
        scope: &Scope,
        brightness: f64,
        color_temperature_kelvin: f64,
    ) -> Result<UserOffsets, StateError> {
        let state = self.scope_state_mut(scope)?;
        let offsets = state
            .offsets
            .adjusted(brightness, color_temperature_kelvin)?;
        state.offsets = offsets;
        Ok(offsets)
    }

    pub fn adjust_control_offsets(
        &mut self,
        control_id: &ControlId,
        brightness: f64,
        color_temperature_kelvin: f64,
    ) -> Result<UserOffsets, StateError> {
        let scope = self.selected_scope(control_id)?;
        self.adjust_scope_offsets(&scope, brightness, color_temperature_kelvin)
    }

    pub fn compose_scope_target(
        &mut self,
        scope: &Scope,
        live_curve: CurvePoint,
        now: MonotonicTime,
        color_temperature_range: KelvinRange,
    ) -> Result<LightTarget, StateError> {
        self.scope_state_mut(scope)?
            .compose(live_curve, now, color_temperature_range)
    }

    pub fn compose_control_target(
        &mut self,
        control_id: &ControlId,
        live_curve: CurvePoint,
        now: MonotonicTime,
        color_temperature_range: KelvinRange,
    ) -> Result<LightTarget, StateError> {
        let scope = self.selected_scope(control_id)?;
        self.compose_scope_target(&scope, live_curve, now, color_temperature_range)
    }

    pub fn toggle_scope_curve(
        &mut self,
        scope: &Scope,
        live_curve: CurvePoint,
        now: MonotonicTime,
        convergence_duration: ConvergenceDuration,
    ) -> Result<CurveToggleOutcome, StateError> {
        self.scope_state_mut(scope)?
            .toggle_curve(live_curve, now, convergence_duration)
    }

    pub fn toggle_control_curve(
        &mut self,
        control_id: &ControlId,
        live_curve: CurvePoint,
        now: MonotonicTime,
        convergence_duration: ConvergenceDuration,
    ) -> Result<CurveToggleOutcome, StateError> {
        let scope = self.selected_scope(control_id)?;
        self.toggle_scope_curve(&scope, live_curve, now, convergence_duration)
    }

    pub fn last_reset_date(&self) -> Option<LocalDate> {
        self.last_reset_date
    }

    pub fn reset_circadian_if_due(
        &mut self,
        local_date: LocalDate,
        local_time: TimeOfDay,
        reset_time: TimeOfDay,
        monotonic_now: MonotonicTime,
        convergence_duration: ConvergenceDuration,
    ) -> Result<DailyResetOutcome, StateError> {
        let scheduled_date = if local_time >= reset_time {
            local_date
        } else {
            let previous_date = local_date.previous_day()?;
            let Some(last_reset_date) = self.last_reset_date else {
                // Establish an unambiguous durable boundary before commands can freeze state.
                // Initialization records history only; it must not alter current scope modes.
                self.last_reset_date = Some(previous_date);
                return Ok(DailyResetOutcome::MarkerInitialized);
            };
            if last_reset_date >= previous_date {
                return Ok(DailyResetOutcome::NotDue);
            }
            previous_date
        };
        if self
            .last_reset_date
            .is_some_and(|date| date >= scheduled_date)
        {
            return Ok(DailyResetOutcome::NotDue);
        }

        // Clone-then-replace makes all scope transitions and reset marker one aggregate update.
        let mut next = self.clone();
        for state in next.scopes.values_mut() {
            state.begin_unfreeze(monotonic_now, convergence_duration);
        }
        next.last_reset_date = Some(scheduled_date);
        *self = next;
        Ok(DailyResetOutcome::Unfroze)
    }

    pub fn snapshot(&self) -> AutomationSnapshot {
        let scopes = self
            .scopes
            .iter()
            .map(|(scope, state)| ScopeSnapshot {
                scope: scope.clone(),
                on: state.on,
                offsets: state.offsets,
                curve_mode: match state.mode {
                    CurveMode::Frozen { baseline } => PersistedCurveMode::Frozen { baseline },
                    CurveMode::Follow | CurveMode::Converging { .. } => PersistedCurveMode::Follow,
                },
            })
            .collect();
        let controls = self
            .controls
            .iter()
            .map(|(id, state)| ControlSnapshot {
                id: id.clone(),
                selected_scope: state.selected_scope.clone(),
            })
            .collect();
        AutomationSnapshot {
            scopes,
            controls,
            last_reset_date: self.last_reset_date,
        }
    }

    pub fn restore(snapshot: AutomationSnapshot) -> Result<Self, StateError> {
        let mut state = Self {
            scopes: BTreeMap::new(),
            controls: BTreeMap::new(),
            last_reset_date: snapshot.last_reset_date,
        };
        for persisted in snapshot.scopes {
            let scope = persisted.scope;
            let scope_state = ScopeState {
                on: persisted.on,
                offsets: persisted.offsets,
                mode: match persisted.curve_mode {
                    PersistedCurveMode::Follow => CurveMode::Follow,
                    PersistedCurveMode::Frozen { baseline } => CurveMode::Frozen { baseline },
                },
            };
            state.insert_scope(scope, scope_state)?;
        }
        for persisted in snapshot.controls {
            state.insert_control(persisted.id, ControlState::new(persisted.selected_scope))?;
        }
        Ok(state)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AutomationSnapshot {
    scopes: Vec<ScopeSnapshot>,
    controls: Vec<ControlSnapshot>,
    last_reset_date: Option<LocalDate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ScopeSnapshot {
    scope: Scope,
    on: bool,
    offsets: UserOffsets,
    curve_mode: PersistedCurveMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum PersistedCurveMode {
    Follow,
    Frozen { baseline: CircadianBaseline },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ControlSnapshot {
    id: ControlId,
    selected_scope: Scope,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StateError {
    InvalidIdentifier,
    InvalidLocalDate,
    LocalDateOutOfRange,
    NonFinite,
    NegativeMonotonicTime,
    NonPositiveConvergenceDuration,
    MonotonicClockRegressed,
    UnknownScope(Scope),
    UnknownControl(ControlId),
    DuplicateScope(Scope),
    DuplicateControl(ControlId),
    InvalidValue(ValueError),
}

impl Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier => formatter.write_str(
                "identifier must be 1..=64 ASCII lowercase letters/digits with internal '_' or '-'",
            ),
            Self::InvalidLocalDate => formatter.write_str("invalid Gregorian local date"),
            Self::LocalDateOutOfRange => {
                formatter.write_str("previous local date cannot be represented")
            }
            Self::NonFinite => formatter.write_str("value must be finite"),
            Self::NegativeMonotonicTime => {
                formatter.write_str("monotonic time must not be negative")
            }
            Self::NonPositiveConvergenceDuration => {
                formatter.write_str("convergence duration must be greater than zero")
            }
            Self::MonotonicClockRegressed => formatter.write_str("monotonic clock regressed"),
            Self::UnknownScope(scope) => write!(formatter, "unknown scope {scope:?}"),
            Self::UnknownControl(control) => write!(formatter, "unknown control {control:?}"),
            Self::DuplicateScope(scope) => write!(formatter, "duplicate scope {scope:?}"),
            Self::DuplicateControl(control) => write!(formatter, "duplicate control {control:?}"),
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
    use serde::{Serialize, de::DeserializeOwned};
    use serde_json::json;

    use crate::{
        curve::{CircadianCurve, CurveAnchor, CurvePoint, TimeOfDay},
        value::{Brightness, KelvinRange},
    };

    use super::{
        AutomationSnapshot, AutomationState, ControlId, ControlState, ConvergenceDuration,
        CurveMode, CurveToggleOutcome, DailyResetOutcome, LocalDate, MonotonicTime, Scope, ScopeId,
        ScopeMembership, ScopeState, StateError, UserOffsets,
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

    fn configured_state() -> AutomationState {
        let mut state = AutomationState::default();
        state
            .insert_scope(room("kitchen"), ScopeState::new(true))
            .unwrap();
        for id in ["remote_a", "remote_b"] {
            state
                .insert_control(
                    ControlId::new(id).unwrap(),
                    ControlState::new(room("kitchen")),
                )
                .unwrap();
        }
        state
    }

    fn assert_json_round_trip<T>(value: &T)
    where
        T: Serialize + DeserializeOwned + std::fmt::Debug + PartialEq,
    {
        let encoded = serde_json::to_string(value).unwrap();
        assert_eq!(&serde_json::from_str::<T>(&encoded).unwrap(), value);
    }

    #[test]
    fn identifiers_enforce_safe_topic_and_log_grammar_in_constructors_and_serde() {
        let too_long = "a".repeat(65);
        for invalid in [
            "",
            "_bad",
            "bad_",
            "-bad",
            "bad-",
            "bad/name",
            "bad+name",
            "bad#name",
            "bad name",
            "Bad",
            "bad\nname",
            too_long.as_str(),
        ] {
            assert!(ScopeId::new(invalid).is_err(), "accepted {invalid:?}");
            assert!(ControlId::new(invalid).is_err(), "accepted {invalid:?}");
            let encoded = serde_json::to_string(invalid).unwrap();
            assert!(serde_json::from_str::<ScopeId>(&encoded).is_err());
            assert!(serde_json::from_str::<ControlId>(&encoded).is_err());
        }

        let max_length = "a".repeat(64);
        for valid in ["a", "room-1", "remote_2", max_length.as_str()] {
            assert_json_round_trip(&ScopeId::new(valid).unwrap());
            assert_json_round_trip(&ControlId::new(valid).unwrap());
        }
    }

    #[test]
    fn scope_membership_matches_configured_room_floor_and_house() {
        let membership = ScopeMembership::new(
            ScopeId::new("kitchen").unwrap(),
            ScopeId::new("ground").unwrap(),
        );
        assert!(membership.is_in(&room("kitchen")));
        assert!(membership.is_in(&Scope::Floor(ScopeId::new("ground").unwrap())));
        assert!(membership.is_in(&Scope::House));
        assert!(!membership.is_in(&room("bedroom")));
        assert!(!membership.is_in(&Scope::Floor(ScopeId::new("upper").unwrap())));
        assert_json_round_trip(&membership);
    }

    #[test]
    fn local_dates_validate_gregorian_century_rules() {
        assert!(LocalDate::new(1900, 2, 29).is_err());
        assert!(LocalDate::new(2000, 2, 29).is_ok());
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
    fn controls_target_one_shared_scope_state_without_divergence() {
        let mut state = configured_state();
        let remote_a = ControlId::new("remote_a").unwrap();
        let remote_b = ControlId::new("remote_b").unwrap();
        let kitchen = room("kitchen");

        state
            .adjust_control_offsets(&remote_a, 0.15, -300.0)
            .unwrap();
        assert!(!state.toggle_control_power(&remote_b).unwrap());
        let target = state
            .compose_control_target(
                &remote_b,
                point(0.45, 2_700.0),
                MonotonicTime::from_seconds(1.0).unwrap(),
                KelvinRange::new(2_200.0, 6_500.0).unwrap(),
            )
            .unwrap();

        assert!(!target.on);
        assert!((target.brightness.unwrap().get() - 0.6).abs() < 1e-12);
        assert_eq!(target.color_temperature.unwrap().get(), 2_400.0);
        assert_eq!(
            state.scope_state(&kitchen).unwrap().offsets(),
            UserOffsets::new(0.15, -300.0).unwrap()
        );
    }

    #[test]
    fn encapsulated_actions_query_iterate_select_and_reject_unknown_ids() {
        let mut state = configured_state();
        let kitchen = room("kitchen");
        let bedroom = room("bedroom");
        let remote_a = ControlId::new("remote_a").unwrap();
        let missing = ControlId::new("missing").unwrap();

        assert_eq!(state.scope_states().count(), 1);
        assert_eq!(state.control_states().count(), 2);
        assert!(state.scope_state(&kitchen).unwrap().is_on());
        assert_eq!(
            state.control_state(&remote_a).unwrap().selected_scope(),
            &kitchen
        );
        assert_eq!(
            state.scope_state(&bedroom),
            Err(StateError::UnknownScope(bedroom.clone()))
        );
        assert_eq!(
            state.control_state(&missing),
            Err(StateError::UnknownControl(missing.clone()))
        );
        assert_eq!(
            state.insert_control(
                ControlId::new("orphan").unwrap(),
                ControlState::new(bedroom.clone())
            ),
            Err(StateError::UnknownScope(bedroom.clone()))
        );
        assert_eq!(
            state.select_control_scope(&remote_a, bedroom.clone()),
            Err(StateError::UnknownScope(bedroom.clone()))
        );
        assert_eq!(
            state.set_scope_power(&bedroom, false),
            Err(StateError::UnknownScope(bedroom))
        );
        assert_eq!(
            state.toggle_control_power(&missing),
            Err(StateError::UnknownControl(missing))
        );
    }

    #[test]
    fn selection_power_and_offset_apis_update_scope_state() {
        let mut state = configured_state();
        let bedroom = room("bedroom");
        let remote_a = ControlId::new("remote_a").unwrap();
        state
            .insert_scope(bedroom.clone(), ScopeState::new(false))
            .unwrap();
        state
            .select_control_scope(&remote_a, bedroom.clone())
            .unwrap();
        state.set_scope_power(&bedroom, true).unwrap();
        state
            .set_scope_offsets(&bedroom, UserOffsets::new(0.1, 200.0).unwrap())
            .unwrap();
        state.adjust_scope_offsets(&bedroom, -0.05, 50.0).unwrap();

        assert_eq!(
            state.control_state(&remote_a).unwrap().selected_scope(),
            &bedroom
        );
        assert!(state.scope_state(&bedroom).unwrap().is_on());
        let offsets = state.scope_state(&bedroom).unwrap().offsets();
        assert!((offsets.brightness() - 0.05).abs() < 1e-12);
        assert_eq!(offsets.color_temperature_kelvin(), 250.0);
    }

    #[test]
    fn freeze_captures_unoffset_baseline_and_later_offset_changes_compose() {
        let mut state = configured_state();
        let kitchen = room("kitchen");
        let duration = ConvergenceDuration::from_seconds(20.0).unwrap();
        assert_eq!(
            state
                .toggle_scope_curve(
                    &kitchen,
                    point(0.45, 2_700.0),
                    MonotonicTime::from_seconds(10.0).unwrap(),
                    duration,
                )
                .unwrap(),
            CurveToggleOutcome::Frozen
        );
        state
            .set_scope_offsets(&kitchen, UserOffsets::new(0.15, -300.0).unwrap())
            .unwrap();
        let target = state
            .compose_scope_target(
                &kitchen,
                point(0.2, 4_000.0),
                MonotonicTime::from_seconds(100.0).unwrap(),
                KelvinRange::new(2_200.0, 6_500.0).unwrap(),
            )
            .unwrap();
        assert!((target.brightness.unwrap().get() - 0.6).abs() < 1e-12);
        assert_eq!(target.color_temperature.unwrap().get(), 2_400.0);
    }

    #[test]
    fn frozen_baseline_stays_constant_as_time_and_live_curve_advance() {
        let mut state = configured_state();
        let kitchen = room("kitchen");
        state
            .toggle_scope_curve(
                &kitchen,
                point(0.45, 2_700.0),
                MonotonicTime::from_seconds(1.0).unwrap(),
                ConvergenceDuration::from_seconds(20.0).unwrap(),
            )
            .unwrap();
        let range = KelvinRange::new(2_200.0, 6_500.0).unwrap();
        let first = state
            .compose_scope_target(
                &kitchen,
                point(0.2, 4_000.0),
                MonotonicTime::from_seconds(100.0).unwrap(),
                range,
            )
            .unwrap();
        let later = state
            .compose_scope_target(
                &kitchen,
                point(0.9, 6_000.0),
                MonotonicTime::from_seconds(10_000.0).unwrap(),
                range,
            )
            .unwrap();
        assert_eq!(first, later);
    }

    #[test]
    fn unfreeze_converges_then_follows_live_curve_and_returns_outcome() {
        let mut state = configured_state();
        let kitchen = room("kitchen");
        let duration = ConvergenceDuration::from_seconds(10.0).unwrap();
        state
            .toggle_scope_curve(
                &kitchen,
                point(0.4, 2_700.0),
                MonotonicTime::from_seconds(10.0).unwrap(),
                duration,
            )
            .unwrap();
        assert_eq!(
            state
                .toggle_control_curve(
                    &ControlId::new("remote_a").unwrap(),
                    point(0.8, 5_000.0),
                    MonotonicTime::from_seconds(10.0).unwrap(),
                    duration,
                )
                .unwrap(),
            CurveToggleOutcome::Unfrozen
        );
        let halfway = state
            .compose_scope_target(
                &kitchen,
                point(0.8, 5_000.0),
                MonotonicTime::from_seconds(15.0).unwrap(),
                KelvinRange::new(2_000.0, 6_500.0).unwrap(),
            )
            .unwrap();
        assert!((halfway.brightness.unwrap().get() - 0.6).abs() < 1e-12);
        assert_eq!(halfway.color_temperature.unwrap().get(), 3_850.0);
        let followed = state
            .compose_scope_target(
                &kitchen,
                point(0.7, 4_500.0),
                MonotonicTime::from_seconds(20.0).unwrap(),
                KelvinRange::new(2_000.0, 6_500.0).unwrap(),
            )
            .unwrap();
        assert_eq!(followed.brightness.unwrap().get(), 0.7);
        assert_eq!(
            state.scope_state(&kitchen).unwrap().mode(),
            &CurveMode::Follow
        );
    }

    #[test]
    fn toggling_during_convergence_freezes_current_unoffset_baseline_without_jump() {
        let mut state = configured_state();
        let kitchen = room("kitchen");
        let duration = ConvergenceDuration::from_seconds(10.0).unwrap();
        state
            .set_scope_offsets(&kitchen, UserOffsets::new(0.1, 100.0).unwrap())
            .unwrap();
        state
            .toggle_scope_curve(
                &kitchen,
                point(0.4, 2_700.0),
                MonotonicTime::from_seconds(10.0).unwrap(),
                duration,
            )
            .unwrap();
        state
            .toggle_scope_curve(
                &kitchen,
                point(0.8, 5_000.0),
                MonotonicTime::from_seconds(10.0).unwrap(),
                duration,
            )
            .unwrap();
        assert_eq!(
            state
                .toggle_scope_curve(
                    &kitchen,
                    point(0.8, 5_000.0),
                    MonotonicTime::from_seconds(15.0).unwrap(),
                    duration,
                )
                .unwrap(),
            CurveToggleOutcome::Frozen
        );
        let target = state
            .compose_scope_target(
                &kitchen,
                point(0.1, 2_200.0),
                MonotonicTime::from_seconds(99.0).unwrap(),
                KelvinRange::new(2_000.0, 6_500.0).unwrap(),
            )
            .unwrap();
        assert!((target.brightness.unwrap().get() - 0.7).abs() < 1e-12);
        assert_eq!(target.color_temperature.unwrap().get(), 3_950.0);
    }

    #[test]
    fn composition_clamps_offsets_and_clock_regression_is_explicit() {
        let mut state = configured_state();
        let kitchen = room("kitchen");
        state
            .set_scope_offsets(&kitchen, UserOffsets::new(0.8, -2_000.0).unwrap())
            .unwrap();
        let target = state
            .compose_scope_target(
                &kitchen,
                point(0.5, 3_000.0),
                MonotonicTime::from_seconds(0.0).unwrap(),
                KelvinRange::new(2_200.0, 6_500.0).unwrap(),
            )
            .unwrap();
        assert_eq!(target.brightness.unwrap().get(), 1.0);
        assert_eq!(target.color_temperature.unwrap().get(), 2_200.0);

        let duration = ConvergenceDuration::from_seconds(10.0).unwrap();
        state
            .toggle_scope_curve(
                &kitchen,
                point(0.4, 2_700.0),
                MonotonicTime::from_seconds(10.0).unwrap(),
                duration,
            )
            .unwrap();
        state
            .toggle_scope_curve(
                &kitchen,
                point(0.8, 5_000.0),
                MonotonicTime::from_seconds(10.0).unwrap(),
                duration,
            )
            .unwrap();
        assert_eq!(
            state.compose_scope_target(
                &kitchen,
                point(0.8, 5_000.0),
                MonotonicTime::from_seconds(9.0).unwrap(),
                KelvinRange::new(2_000.0, 6_500.0).unwrap(),
            ),
            Err(StateError::MonotonicClockRegressed)
        );
    }

    #[test]
    fn nightly_reset_unfreezes_every_scope_without_restarting_convergence() {
        let mut state = AutomationState::default();
        let kitchen = room("kitchen");
        let bedroom = room("bedroom");
        let floor = Scope::Floor(ScopeId::new("ground").unwrap());
        let office = room("office");
        for (scope, on) in [
            (kitchen.clone(), false),
            (bedroom.clone(), true),
            (floor.clone(), true),
            (office.clone(), true),
        ] {
            state.insert_scope(scope, ScopeState::new(on)).unwrap();
        }
        let duration = ConvergenceDuration::from_seconds(20.0).unwrap();
        for scope in [&kitchen, &bedroom, &office] {
            state
                .toggle_scope_curve(
                    scope,
                    point(0.4, 2_700.0),
                    MonotonicTime::from_seconds(10.0).unwrap(),
                    duration,
                )
                .unwrap();
        }
        state
            .toggle_scope_curve(
                &office,
                point(0.8, 5_000.0),
                MonotonicTime::from_seconds(10.0).unwrap(),
                duration,
            )
            .unwrap();
        let office_before = *state.scope_state(&office).unwrap().mode();
        state
            .set_scope_offsets(&kitchen, UserOffsets::new(0.1, 100.0).unwrap())
            .unwrap();

        let date = LocalDate::new(2026, 9, 13).unwrap();
        assert_eq!(
            state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(4, 0, 0).unwrap(),
                    TimeOfDay::from_hms(4, 0, 0).unwrap(),
                    MonotonicTime::from_seconds(50.0).unwrap(),
                    duration,
                )
                .unwrap(),
            DailyResetOutcome::Unfroze
        );
        for scope in [&kitchen, &bedroom] {
            assert!(matches!(
                state.scope_state(scope).unwrap().mode(),
                CurveMode::Converging { .. }
            ));
        }
        assert_eq!(
            state.scope_state(&floor).unwrap().mode(),
            &CurveMode::Follow
        );
        assert_eq!(state.scope_state(&office).unwrap().mode(), &office_before);
        assert!(!state.scope_state(&kitchen).unwrap().is_on());
        assert_eq!(
            state.scope_state(&kitchen).unwrap().offsets(),
            UserOffsets::new(0.1, 100.0).unwrap()
        );
        assert_eq!(state.last_reset_date(), Some(date));
    }

    #[test]
    fn reset_schedule_is_idempotent_and_records_due_empty_state() {
        let date = LocalDate::new(2026, 9, 13).unwrap();
        let reset_time = TimeOfDay::from_hms(4, 0, 0).unwrap();
        let duration = ConvergenceDuration::from_seconds(20.0).unwrap();
        let mut state = AutomationState::default();

        assert_eq!(
            state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(3, 59, 59).unwrap(),
                    reset_time,
                    MonotonicTime::from_seconds(10.0).unwrap(),
                    duration,
                )
                .unwrap(),
            DailyResetOutcome::MarkerInitialized
        );
        assert_eq!(
            state.last_reset_date(),
            Some(LocalDate::new(2026, 9, 12).unwrap())
        );
        assert_eq!(
            state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(10, 0, 0).unwrap(),
                    reset_time,
                    MonotonicTime::from_seconds(20.0).unwrap(),
                    duration,
                )
                .unwrap(),
            DailyResetOutcome::Unfroze
        );
        let after = state.clone();
        assert_eq!(
            state
                .reset_circadian_if_due(
                    date,
                    TimeOfDay::from_hms(23, 0, 0).unwrap(),
                    reset_time,
                    MonotonicTime::from_seconds(30.0).unwrap(),
                    duration,
                )
                .unwrap(),
            DailyResetOutcome::NotDue
        );
        assert_eq!(state, after);
        assert_eq!(state.last_reset_date(), Some(date));
    }

    #[test]
    fn startup_catches_latest_missed_reset_before_and_after_four() {
        let today = LocalDate::new(2026, 9, 13).unwrap();
        let reset_time = TimeOfDay::from_hms(4, 0, 0).unwrap();
        let now = MonotonicTime::from_seconds(1.0).unwrap();
        let duration = ConvergenceDuration::from_seconds(20.0).unwrap();
        let mut after_four =
            AutomationState::with_last_reset_date(LocalDate::new(2026, 9, 12).unwrap());
        assert_eq!(
            after_four
                .reset_circadian_if_due(today, time(12), reset_time, now, duration)
                .unwrap(),
            DailyResetOutcome::Unfroze
        );
        assert_eq!(after_four.last_reset_date(), Some(today));

        let mut missed_yesterday =
            AutomationState::with_last_reset_date(LocalDate::new(2026, 9, 11).unwrap());
        assert_eq!(
            missed_yesterday
                .reset_circadian_if_due(today, time(3), reset_time, now, duration)
                .unwrap(),
            DailyResetOutcome::Unfroze
        );
        assert_eq!(
            missed_yesterday.last_reset_date(),
            Some(LocalDate::new(2026, 9, 12).unwrap())
        );
        let mut completed_yesterday =
            AutomationState::with_last_reset_date(LocalDate::new(2026, 9, 12).unwrap());
        assert_eq!(
            completed_yesterday
                .reset_circadian_if_due(today, time(3), reset_time, now, duration)
                .unwrap(),
            DailyResetOutcome::NotDue
        );
    }

    #[test]
    fn missed_reset_previous_day_handles_month_leap_century_and_year_boundaries() {
        let cases = [
            ((2024, 2, 28), (2024, 3, 1), (2024, 2, 29)),
            ((1900, 2, 27), (1900, 3, 1), (1900, 2, 28)),
            ((1999, 12, 30), (2000, 1, 1), (1999, 12, 31)),
        ];
        for (last, today, expected) in cases {
            let mut state = AutomationState::with_last_reset_date(
                LocalDate::new(last.0, last.1, last.2).unwrap(),
            );
            assert_eq!(
                state
                    .reset_circadian_if_due(
                        LocalDate::new(today.0, today.1, today.2).unwrap(),
                        time(3),
                        time(4),
                        MonotonicTime::from_seconds(1.0).unwrap(),
                        ConvergenceDuration::from_seconds(20.0).unwrap(),
                    )
                    .unwrap(),
                DailyResetOutcome::Unfroze
            );
            assert_eq!(
                state.last_reset_date(),
                Some(LocalDate::new(expected.0, expected.1, expected.2).unwrap())
            );
        }
    }

    #[test]
    fn fresh_marker_persists_before_commands_and_stale_freeze_resets_once() {
        let kitchen = room("kitchen");
        let duration = ConvergenceDuration::from_seconds(20.0).unwrap();
        let mut state = configured_state();

        let initialized = state
            .reset_circadian_if_due(
                LocalDate::new(2026, 9, 13).unwrap(),
                time(1),
                time(4),
                MonotonicTime::from_seconds(1.0).unwrap(),
                duration,
            )
            .unwrap();
        assert_eq!(initialized, DailyResetOutcome::MarkerInitialized);
        assert!(initialized.durable_state_changed());
        assert_eq!(
            state.last_reset_date(),
            Some(LocalDate::new(2026, 9, 12).unwrap())
        );
        assert_eq!(
            state.scope_state(&kitchen).unwrap().mode(),
            &CurveMode::Follow
        );

        state
            .toggle_scope_curve(
                &kitchen,
                point(0.4, 2_700.0),
                MonotonicTime::from_seconds(2.0).unwrap(),
                duration,
            )
            .unwrap();
        let encoded = serde_json::to_string(&state.snapshot()).unwrap();
        let snapshot: AutomationSnapshot = serde_json::from_str(&encoded).unwrap();
        let mut restored = AutomationState::restore(snapshot).unwrap();

        let reset = restored
            .reset_circadian_if_due(
                LocalDate::new(2026, 9, 15).unwrap(),
                time(3),
                time(4),
                MonotonicTime::from_seconds(0.0).unwrap(),
                duration,
            )
            .unwrap();
        assert_eq!(reset, DailyResetOutcome::Unfroze);
        assert!(reset.durable_state_changed());
        assert!(matches!(
            restored.scope_state(&kitchen).unwrap().mode(),
            CurveMode::Converging { .. }
        ));
        let after_first = restored.clone();
        assert_eq!(
            restored
                .reset_circadian_if_due(
                    LocalDate::new(2026, 9, 15).unwrap(),
                    time(3),
                    time(4),
                    MonotonicTime::from_seconds(1.0).unwrap(),
                    duration,
                )
                .unwrap(),
            DailyResetOutcome::NotDue
        );
        assert!(!DailyResetOutcome::NotDue.durable_state_changed());
        assert_eq!(restored, after_first);
    }

    #[test]
    fn frozen_snapshot_round_trip_remains_frozen() {
        let mut state = configured_state();
        let kitchen = room("kitchen");
        state
            .toggle_scope_curve(
                &kitchen,
                point(0.4, 2_700.0),
                MonotonicTime::from_seconds(10.0).unwrap(),
                ConvergenceDuration::from_seconds(20.0).unwrap(),
            )
            .unwrap();
        let encoded = serde_json::to_string(&state.snapshot()).unwrap();
        let decoded: AutomationSnapshot = serde_json::from_str(&encoded).unwrap();
        let restored = AutomationState::restore(decoded).unwrap();
        assert!(matches!(
            restored.scope_state(&kitchen).unwrap().mode(),
            CurveMode::Frozen { .. }
        ));
        assert_eq!(restored.control_states().count(), 2);
    }

    #[test]
    fn converging_snapshot_restores_follow_for_new_monotonic_epoch() {
        let mut state = configured_state();
        let kitchen = room("kitchen");
        let duration = ConvergenceDuration::from_seconds(20.0).unwrap();
        for _ in 0..2 {
            state
                .toggle_scope_curve(
                    &kitchen,
                    point(0.4, 2_700.0),
                    MonotonicTime::from_seconds(100.0).unwrap(),
                    duration,
                )
                .unwrap();
        }
        let mut restored = AutomationState::restore(state.snapshot()).unwrap();
        assert_eq!(
            restored.scope_state(&kitchen).unwrap().mode(),
            &CurveMode::Follow
        );
        let target = restored
            .compose_scope_target(
                &kitchen,
                point(0.7, 4_500.0),
                MonotonicTime::from_seconds(0.0).unwrap(),
                KelvinRange::new(2_000.0, 6_500.0).unwrap(),
            )
            .unwrap();
        assert_eq!(target.brightness.unwrap().get(), 0.7);
    }

    #[test]
    fn restore_rejects_control_selection_for_unknown_scope() {
        let snapshot: AutomationSnapshot = serde_json::from_value(json!({
            "scopes": [],
            "controls": [{
                "id": "remote_a",
                "selected_scope": { "room": "missing" }
            }],
            "last_reset_date": null
        }))
        .unwrap();
        assert_eq!(
            AutomationState::restore(snapshot),
            Err(StateError::UnknownScope(room("missing")))
        );
    }
}
