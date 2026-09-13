use std::{
    collections::{BTreeMap, btree_map},
    error::Error,
    fmt::{self, Display},
};

use serde::{Deserialize, Serialize};

use crate::{
    curve::CurvePoint,
    overlay::{AcknowledgementRequest, AcknowledgementSettings},
    state::{
        AutomationState, ControlId, ConvergenceDuration, CurveToggleOutcome, MonotonicTime, Scope,
        StateError, UserOffsets,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub struct ClickWindow(f64);

impl ClickWindow {
    pub fn from_seconds(seconds: f64) -> Result<Self, InputError> {
        if !seconds.is_finite() {
            return Err(InputError::NonFinite);
        }
        if seconds <= 0.0 {
            return Err(InputError::NonPositiveClickWindow);
        }
        Ok(Self(seconds))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawInputEvent {
    Up,
    Down,
    Left,
    Right,
    CenterShort,
    CenterLong,
    CenterRelease,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Gesture {
    Up,
    Down,
    Left,
    Right,
    CenterSingle,
    CenterDouble,
    CenterLong,
    CenterRelease,
}

pub type ClassifiedInput = (ControlId, Gesture);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct FiniteDelta(f64);

impl FiniteDelta {
    pub fn new(value: f64) -> Result<Self, InputError> {
        if !value.is_finite() {
            return Err(InputError::NonFinite);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for FiniteDelta {
    type Error = InputError;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<FiniteDelta> for f64 {
    fn from(value: FiniteDelta) -> Self {
        value.get()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeTarget {
    SelectedScope,
    Explicit(Scope),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    AdjustBrightnessOffset(FiniteDelta),
    AdjustColorTemperatureOffset(FiniteDelta),
    TogglePower,
    ToggleCircadian,
    SelectScope,
}

impl Action {
    pub fn brightness_offset(delta: f64) -> Result<Self, InputError> {
        Ok(Self::AdjustBrightnessOffset(FiniteDelta::new(delta)?))
    }

    pub fn color_temperature_offset(delta_kelvin: f64) -> Result<Self, InputError> {
        Ok(Self::AdjustColorTemperatureOffset(FiniteDelta::new(
            delta_kelvin,
        )?))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "MappingEntryRepr", into = "MappingEntryRepr")]
pub struct MappingEntry {
    gesture: Gesture,
    target: ScopeTarget,
    action: Action,
}

impl MappingEntry {
    pub fn new(gesture: Gesture, target: ScopeTarget, action: Action) -> Result<Self, InputError> {
        if matches!(action, Action::SelectScope) && matches!(target, ScopeTarget::SelectedScope) {
            return Err(InputError::SelectScopeRequiresExplicitTarget);
        }
        Ok(Self {
            gesture,
            target,
            action,
        })
    }

    pub fn gesture(&self) -> Gesture {
        self.gesture
    }

    pub fn target(&self) -> &ScopeTarget {
        &self.target
    }

    pub fn action(&self) -> Action {
        self.action
    }
}

#[derive(Serialize, Deserialize)]
struct MappingEntryRepr {
    gesture: Gesture,
    target: ScopeTarget,
    action: Action,
}

impl TryFrom<MappingEntryRepr> for MappingEntry {
    type Error = InputError;

    fn try_from(value: MappingEntryRepr) -> Result<Self, Self::Error> {
        Self::new(value.gesture, value.target, value.action)
    }
}

impl From<MappingEntry> for MappingEntryRepr {
    fn from(value: MappingEntry) -> Self {
        Self {
            gesture: value.gesture,
            target: value.target,
            action: value.action,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "Vec<MappingEntry>", into = "Vec<MappingEntry>")]
pub struct Mapping {
    entries: BTreeMap<Gesture, MappingEntry>,
}

impl Mapping {
    pub fn new(entries: Vec<MappingEntry>) -> Result<Self, InputError> {
        let mut by_gesture = BTreeMap::new();
        for entry in entries {
            match by_gesture.entry(entry.gesture) {
                btree_map::Entry::Vacant(slot) => {
                    slot.insert(entry);
                }
                btree_map::Entry::Occupied(slot) => {
                    return Err(InputError::DuplicateGesture(*slot.key()));
                }
            }
        }
        Ok(Self {
            entries: by_gesture,
        })
    }

    pub fn entry(&self, gesture: Gesture) -> Option<&MappingEntry> {
        self.entries.get(&gesture)
    }

    pub fn execute(
        &self,
        control_id: &ControlId,
        gesture: Gesture,
        state: &mut AutomationState,
        context: ActionContext<'_>,
    ) -> Result<Option<ActionOutcome>, InputError> {
        // Validate the event source even when no action is mapped.
        let selected_scope = state.control_state(control_id)?.selected_scope().clone();
        let Some(entry) = self.entry(gesture) else {
            return Ok(None);
        };
        let scope = match &entry.target {
            ScopeTarget::SelectedScope => selected_scope,
            ScopeTarget::Explicit(scope) => scope.clone(),
        };
        state.scope_state(&scope)?;

        let outcome = match entry.action {
            Action::AdjustBrightnessOffset(delta) => {
                let offsets = state.adjust_scope_offsets(&scope, delta.get(), 0.0)?;
                ActionOutcome::BrightnessOffsetAdjusted { scope, offsets }
            }
            Action::AdjustColorTemperatureOffset(delta) => {
                let offsets = state.adjust_scope_offsets(&scope, 0.0, delta.get())?;
                ActionOutcome::ColorTemperatureOffsetAdjusted { scope, offsets }
            }
            Action::TogglePower => {
                let on = state.toggle_scope_power(&scope)?;
                ActionOutcome::PowerToggled { scope, on }
            }
            Action::ToggleCircadian => {
                let context = context.toggle.ok_or(InputError::MissingToggleContext)?;
                let acknowledgement_target = context
                    .acknowledgement
                    .map(|_| state.compose_scope_layers(&scope, context.live_curve, context.now))
                    .transpose()?;
                let toggle = state.toggle_scope_curve(
                    &scope,
                    context.live_curve,
                    context.now,
                    context.convergence_duration,
                )?;
                let acknowledgement = context
                    .acknowledgement
                    .zip(acknowledgement_target)
                    .and_then(|(settings, target)| settings.for_scope_toggle(toggle, &target));
                ActionOutcome::CircadianToggled {
                    scope,
                    outcome: toggle,
                    acknowledgement,
                }
            }
            Action::SelectScope => {
                state.select_control_scope(control_id, scope.clone())?;
                ActionOutcome::ScopeSelected { scope }
            }
        };
        Ok(Some(outcome))
    }
}

impl TryFrom<Vec<MappingEntry>> for Mapping {
    type Error = InputError;

    fn try_from(value: Vec<MappingEntry>) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<Mapping> for Vec<MappingEntry> {
    fn from(value: Mapping) -> Self {
        value.entries.into_values().collect()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ToggleContext<'a> {
    live_curve: CurvePoint,
    now: MonotonicTime,
    convergence_duration: ConvergenceDuration,
    acknowledgement: Option<&'a AcknowledgementSettings>,
}

impl<'a> ToggleContext<'a> {
    pub fn new(
        live_curve: CurvePoint,
        now: MonotonicTime,
        convergence_duration: ConvergenceDuration,
    ) -> Self {
        Self {
            live_curve,
            now,
            convergence_duration,
            acknowledgement: None,
        }
    }

    pub fn with_acknowledgement(mut self, settings: &'a AcknowledgementSettings) -> Self {
        self.acknowledgement = Some(settings);
        self
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ActionContext<'a> {
    toggle: Option<ToggleContext<'a>>,
}

impl<'a> ActionContext<'a> {
    pub fn with_toggle(mut self, toggle: ToggleContext<'a>) -> Self {
        self.toggle = Some(toggle);
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ActionOutcome {
    BrightnessOffsetAdjusted {
        scope: Scope,
        offsets: UserOffsets,
    },
    ColorTemperatureOffsetAdjusted {
        scope: Scope,
        offsets: UserOffsets,
    },
    PowerToggled {
        scope: Scope,
        on: bool,
    },
    CircadianToggled {
        scope: Scope,
        outcome: CurveToggleOutcome,
        acknowledgement: Option<AcknowledgementRequest>,
    },
    ScopeSelected {
        scope: Scope,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClickClassifier {
    window: ClickWindow,
    pending: BTreeMap<ControlId, f64>,
    last_observed: Option<MonotonicTime>,
}

impl ClickClassifier {
    pub fn new(window: ClickWindow) -> Self {
        Self {
            window,
            pending: BTreeMap::new(),
            last_observed: None,
        }
    }

    pub fn ingest(
        &mut self,
        control_id: ControlId,
        raw: RawInputEvent,
        now: MonotonicTime,
    ) -> Result<Vec<ClassifiedInput>, InputError> {
        self.validate_monotonic(now)?;
        let new_deadline = if raw == RawInputEvent::CenterShort
            && !self
                .pending
                .get(&control_id)
                .is_some_and(|deadline| now.seconds() <= *deadline)
        {
            let deadline = now.seconds() + self.window.0;
            if !deadline.is_finite() || deadline <= now.seconds() {
                return Err(InputError::DeadlineOverflow);
            }
            Some(deadline)
        } else {
            None
        };
        let mut events = self.take_due(now);

        match raw {
            RawInputEvent::CenterShort => {
                if let Some(deadline) = self.pending.remove(&control_id) {
                    debug_assert!(now.seconds() <= deadline);
                    events.push((control_id, Gesture::CenterDouble));
                } else {
                    let deadline =
                        new_deadline.expect("new center-short sequence has a validated deadline");
                    self.pending.insert(control_id, deadline);
                }
            }
            RawInputEvent::CenterLong | RawInputEvent::CenterRelease => {
                if self.pending.remove(&control_id).is_some() {
                    events.push((control_id.clone(), Gesture::CenterSingle));
                }
                let gesture = match raw {
                    RawInputEvent::CenterLong => Gesture::CenterLong,
                    RawInputEvent::CenterRelease => Gesture::CenterRelease,
                    _ => unreachable!("outer match restricts center gesture"),
                };
                events.push((control_id, gesture));
            }
            RawInputEvent::Up
            | RawInputEvent::Down
            | RawInputEvent::Left
            | RawInputEvent::Right => {
                let gesture = match raw {
                    RawInputEvent::Up => Gesture::Up,
                    RawInputEvent::Down => Gesture::Down,
                    RawInputEvent::Left => Gesture::Left,
                    RawInputEvent::Right => Gesture::Right,
                    _ => unreachable!("outer match restricts directional gesture"),
                };
                events.push((control_id, gesture));
            }
        }

        self.last_observed = Some(now);
        Ok(events)
    }

    pub fn flush_due(&mut self, now: MonotonicTime) -> Result<Vec<ClassifiedInput>, InputError> {
        self.validate_monotonic(now)?;
        let events = self.take_due(now);
        self.last_observed = Some(now);
        Ok(events)
    }

    fn validate_monotonic(&self, now: MonotonicTime) -> Result<(), InputError> {
        if self.last_observed.is_some_and(|previous| now < previous) {
            return Err(InputError::MonotonicClockRegressed);
        }
        Ok(())
    }

    fn take_due(&mut self, now: MonotonicTime) -> Vec<ClassifiedInput> {
        let mut due: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, deadline)| now.seconds() > **deadline)
            .map(|(control_id, deadline)| (*deadline, control_id.clone()))
            .collect();
        due.sort_by(|(left_deadline, left_id), (right_deadline, right_id)| {
            left_deadline
                .total_cmp(right_deadline)
                .then_with(|| left_id.cmp(right_id))
        });
        for (_, control_id) in &due {
            self.pending.remove(control_id);
        }
        due.into_iter()
            .map(|(_, control_id)| (control_id, Gesture::CenterSingle))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum InputError {
    NonFinite,
    NonPositiveClickWindow,
    DeadlineOverflow,
    MonotonicClockRegressed,
    DuplicateGesture(Gesture),
    SelectScopeRequiresExplicitTarget,
    MissingToggleContext,
    State(StateError),
}

impl Display for InputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFinite => formatter.write_str("input value must be finite"),
            Self::NonPositiveClickWindow => {
                formatter.write_str("click window must be greater than zero")
            }
            Self::DeadlineOverflow => formatter.write_str("click deadline exceeds monotonic range"),
            Self::MonotonicClockRegressed => formatter.write_str("monotonic clock regressed"),
            Self::DuplicateGesture(gesture) => {
                write!(formatter, "gesture {gesture:?} has more than one mapping")
            }
            Self::SelectScopeRequiresExplicitTarget => {
                formatter.write_str("select_scope action requires an explicit target")
            }
            Self::MissingToggleContext => {
                formatter.write_str("toggle_circadian action requires current curve and time")
            }
            Self::State(error) => write!(formatter, "automation state error: {error}"),
        }
    }
}

impl Error for InputError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::State(error) => Some(error),
            _ => None,
        }
    }
}

impl From<StateError> for InputError {
    fn from(value: StateError) -> Self {
        Self::State(value)
    }
}

#[cfg(test)]
mod tests {
    use crate::state::{ControlId, MonotonicTime};

    use super::{ClickClassifier, ClickWindow, Gesture, RawInputEvent};

    fn control(value: &str) -> ControlId {
        ControlId::new(value).unwrap()
    }

    fn now(seconds: f64) -> MonotonicTime {
        MonotonicTime::from_seconds(seconds).unwrap()
    }

    fn classifier() -> ClickClassifier {
        ClickClassifier::new(ClickWindow::from_seconds(0.35).unwrap())
    }

    fn gestures(events: &[(ControlId, Gesture)]) -> Vec<Gesture> {
        events.iter().map(|(_, gesture)| *gesture).collect()
    }

    #[test]
    fn first_short_click_waits_then_flushes_strictly_after_deadline() {
        let remote = control("remote-a");
        let mut classifier = classifier();

        assert!(
            classifier
                .ingest(remote.clone(), RawInputEvent::CenterShort, now(10.0))
                .unwrap()
                .is_empty()
        );
        assert!(classifier.flush_due(now(10.35)).unwrap().is_empty());
        assert_eq!(
            classifier.flush_due(now(10.350_001)).unwrap(),
            vec![(remote, Gesture::CenterSingle)]
        );
    }

    #[test]
    fn second_short_click_before_or_at_deadline_emits_only_double() {
        for second_at in [10.349, 10.35] {
            let remote = control("remote-a");
            let mut classifier = classifier();
            classifier
                .ingest(remote.clone(), RawInputEvent::CenterShort, now(10.0))
                .unwrap();

            assert_eq!(
                classifier
                    .ingest(remote.clone(), RawInputEvent::CenterShort, now(second_at))
                    .unwrap(),
                vec![(remote, Gesture::CenterDouble)]
            );
            assert!(classifier.flush_due(now(20.0)).unwrap().is_empty());
        }
    }

    #[test]
    fn click_after_deadline_emits_prior_single_then_starts_new_pending_click() {
        let remote = control("remote-a");
        let mut classifier = classifier();
        classifier
            .ingest(remote.clone(), RawInputEvent::CenterShort, now(1.0))
            .unwrap();

        assert_eq!(
            classifier
                .ingest(remote.clone(), RawInputEvent::CenterShort, now(1.5))
                .unwrap(),
            vec![(remote.clone(), Gesture::CenterSingle)]
        );
        assert_eq!(
            classifier.flush_due(now(1.850_001)).unwrap(),
            vec![(remote, Gesture::CenterSingle)]
        );
    }

    #[test]
    fn third_click_after_completed_double_starts_fresh_single_sequence() {
        let remote = control("remote-a");
        let mut classifier = classifier();
        classifier
            .ingest(remote.clone(), RawInputEvent::CenterShort, now(1.0))
            .unwrap();
        classifier
            .ingest(remote.clone(), RawInputEvent::CenterShort, now(1.1))
            .unwrap();

        assert!(
            classifier
                .ingest(remote.clone(), RawInputEvent::CenterShort, now(1.2))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            classifier.flush_due(now(1.551)).unwrap(),
            vec![(remote, Gesture::CenterSingle)]
        );
    }

    #[test]
    fn long_press_and_release_cannot_pair_with_pending_short_click() {
        for (raw, expected) in [
            (RawInputEvent::CenterLong, Gesture::CenterLong),
            (RawInputEvent::CenterRelease, Gesture::CenterRelease),
        ] {
            let remote = control("remote-a");
            let mut classifier = classifier();
            classifier
                .ingest(remote.clone(), RawInputEvent::CenterShort, now(1.0))
                .unwrap();

            assert_eq!(
                gestures(&classifier.ingest(remote, raw, now(1.1)).unwrap()),
                vec![Gesture::CenterSingle, expected]
            );
            assert!(classifier.flush_due(now(2.0)).unwrap().is_empty());
        }
    }

    #[test]
    fn pending_clicks_are_independent_per_control() {
        let remote_a = control("remote-a");
        let remote_b = control("remote-b");
        let mut classifier = classifier();
        classifier
            .ingest(remote_a.clone(), RawInputEvent::CenterShort, now(1.0))
            .unwrap();
        classifier
            .ingest(remote_b.clone(), RawInputEvent::CenterShort, now(1.1))
            .unwrap();

        assert_eq!(
            classifier
                .ingest(remote_a.clone(), RawInputEvent::CenterShort, now(1.2))
                .unwrap(),
            vec![(remote_a, Gesture::CenterDouble)]
        );
        assert_eq!(
            classifier.flush_due(now(1.451)).unwrap(),
            vec![(remote_b, Gesture::CenterSingle)]
        );
    }

    #[test]
    fn directional_events_are_normalized_without_disturbing_pending_click() {
        let remote = control("remote-a");
        let mut classifier = classifier();
        classifier
            .ingest(remote.clone(), RawInputEvent::CenterShort, now(1.0))
            .unwrap();

        for (raw, expected) in [
            (RawInputEvent::Up, Gesture::Up),
            (RawInputEvent::Down, Gesture::Down),
            (RawInputEvent::Left, Gesture::Left),
            (RawInputEvent::Right, Gesture::Right),
        ] {
            assert_eq!(
                classifier.ingest(remote.clone(), raw, now(1.1)).unwrap(),
                vec![(remote.clone(), expected)]
            );
        }
        assert_eq!(
            classifier.flush_due(now(1.351)).unwrap(),
            vec![(remote, Gesture::CenterSingle)]
        );
    }

    #[test]
    fn monotonic_regression_is_rejected_without_consuming_pending_state() {
        let remote = control("remote-a");
        let mut classifier = classifier();
        classifier
            .ingest(remote.clone(), RawInputEvent::CenterShort, now(10.0))
            .unwrap();

        assert!(classifier.flush_due(now(9.0)).is_err());
        assert_eq!(
            classifier.flush_due(now(10.351)).unwrap(),
            vec![(remote, Gesture::CenterSingle)]
        );
    }

    #[test]
    fn deadline_overflow_is_rejected_without_consuming_other_pending_clicks() {
        let remote_a = control("remote-a");
        let mut classifier = classifier();
        classifier
            .ingest(remote_a.clone(), RawInputEvent::CenterShort, now(1.0))
            .unwrap();
        let before = classifier.clone();

        assert_eq!(
            classifier.ingest(
                control("remote-b"),
                RawInputEvent::CenterShort,
                now(f64::MAX),
            ),
            Err(super::InputError::DeadlineOverflow)
        );
        assert_eq!(classifier, before);
        assert_eq!(
            classifier.flush_due(now(1.351)).unwrap(),
            vec![(remote_a, Gesture::CenterSingle)]
        );
    }

    #[test]
    fn expired_clicks_emit_by_deadline_before_control_identifier() {
        let earlier_id_sorts_later = control("remote-z");
        let later_id_sorts_earlier = control("remote-a");
        let mut classifier = classifier();
        classifier
            .ingest(
                earlier_id_sorts_later.clone(),
                RawInputEvent::CenterShort,
                now(1.0),
            )
            .unwrap();
        classifier
            .ingest(
                later_id_sorts_earlier.clone(),
                RawInputEvent::CenterShort,
                now(1.1),
            )
            .unwrap();

        assert_eq!(
            classifier.flush_due(now(2.0)).unwrap(),
            vec![
                (earlier_id_sorts_later, Gesture::CenterSingle),
                (later_id_sorts_earlier, Gesture::CenterSingle),
            ]
        );
    }

    #[test]
    fn equal_deadlines_emit_by_control_identifier() {
        let remote_z = control("remote-z");
        let remote_a = control("remote-a");
        let mut classifier = classifier();
        classifier
            .ingest(remote_z.clone(), RawInputEvent::CenterShort, now(1.0))
            .unwrap();
        classifier
            .ingest(remote_a.clone(), RawInputEvent::CenterShort, now(1.0))
            .unwrap();

        assert_eq!(
            classifier.flush_due(now(2.0)).unwrap(),
            vec![
                (remote_a, Gesture::CenterSingle),
                (remote_z, Gesture::CenterSingle),
            ]
        );
    }

    #[test]
    fn click_window_rejects_zero_negative_and_non_finite_values() {
        for seconds in [0.0, -0.1, f64::NAN, f64::NEG_INFINITY, f64::INFINITY] {
            assert!(
                ClickWindow::from_seconds(seconds).is_err(),
                "accepted {seconds}"
            );
        }
    }
}

#[cfg(test)]
mod action_tests {
    use crate::{
        curve::{CircadianCurve, CurveAnchor, CurvePoint, TimeOfDay},
        overlay::{AcknowledgementKind, AcknowledgementSettings, OverlayId, OverlaySet},
        state::{
            AutomationState, ControlId, ControlState, ConvergenceDuration, CurveMode,
            CurveToggleOutcome, MonotonicTime, Scope, ScopeId, ScopeState, StateError, UserOffsets,
        },
        value::{Brightness, KelvinRange},
    };

    use super::{
        Action, ActionContext, ActionOutcome, Gesture, InputError, Mapping, MappingEntry,
        ScopeTarget, ToggleContext,
    };

    fn id(value: &str) -> ScopeId {
        ScopeId::new(value).unwrap()
    }

    fn control(value: &str) -> ControlId {
        ControlId::new(value).unwrap()
    }

    fn now(seconds: f64) -> MonotonicTime {
        MonotonicTime::from_seconds(seconds).unwrap()
    }

    fn duration() -> ConvergenceDuration {
        ConvergenceDuration::from_seconds(10.0).unwrap()
    }

    fn live_curve() -> CurvePoint {
        CircadianCurve::new(vec![
            CurveAnchor::new(
                TimeOfDay::from_hms(12, 0, 0).unwrap(),
                Brightness::new(0.4).unwrap(),
                3_000.0,
            )
            .unwrap(),
            CurveAnchor::new(
                TimeOfDay::from_hms(18, 0, 0).unwrap(),
                Brightness::new(0.8).unwrap(),
                5_000.0,
            )
            .unwrap(),
        ])
        .unwrap()
        .sample(TimeOfDay::from_hms(12, 0, 0).unwrap())
    }

    fn state() -> (AutomationState, Scope, Scope, Scope, ControlId, ControlId) {
        let room = Scope::Room(id("kitchen"));
        let floor = Scope::Floor(id("ground"));
        let house = Scope::House;
        let remote_a = control("remote-a");
        let remote_b = control("remote-b");
        let mut state = AutomationState::default();
        for scope in [&room, &floor, &house] {
            state
                .insert_scope(scope.clone(), ScopeState::new(true))
                .unwrap();
        }
        state
            .insert_control(remote_a.clone(), ControlState::new(room.clone()))
            .unwrap();
        state
            .insert_control(remote_b.clone(), ControlState::new(room.clone()))
            .unwrap();
        (state, room, floor, house, remote_a, remote_b)
    }

    fn context() -> ActionContext<'static> {
        ActionContext::default()
    }

    fn mapping(entries: Vec<MappingEntry>) -> Mapping {
        Mapping::new(entries).unwrap()
    }

    #[test]
    fn mapping_is_declarative_serializable_and_rejects_duplicate_gestures() {
        let mapping = mapping(vec![
            MappingEntry::new(
                Gesture::Up,
                ScopeTarget::SelectedScope,
                Action::brightness_offset(0.1).unwrap(),
            )
            .unwrap(),
            MappingEntry::new(
                Gesture::CenterSingle,
                ScopeTarget::Explicit(Scope::House),
                Action::TogglePower,
            )
            .unwrap(),
        ]);
        let json = serde_json::to_string(&mapping).unwrap();
        assert_eq!(serde_json::from_str::<Mapping>(&json).unwrap(), mapping);

        let duplicate_entries = vec![
            MappingEntry::new(
                Gesture::Up,
                ScopeTarget::SelectedScope,
                Action::brightness_offset(0.1).unwrap(),
            )
            .unwrap(),
            MappingEntry::new(
                Gesture::Up,
                ScopeTarget::SelectedScope,
                Action::brightness_offset(0.2).unwrap(),
            )
            .unwrap(),
        ];
        assert_eq!(
            Mapping::new(duplicate_entries.clone()),
            Err(InputError::DuplicateGesture(Gesture::Up))
        );
        assert!(
            serde_json::from_value::<Mapping>(serde_json::to_value(duplicate_entries).unwrap())
                .is_err()
        );
        assert!(
            serde_json::from_value::<MappingEntry>(serde_json::json!({
                "gesture": "center_long",
                "target": "selected_scope",
                "action": "select_scope"
            }))
            .is_err()
        );
    }

    #[test]
    fn offset_actions_reject_non_finite_deltas() {
        for delta in [f64::NAN, f64::NEG_INFINITY, f64::INFINITY] {
            assert!(Action::brightness_offset(delta).is_err());
            assert!(Action::color_temperature_offset(delta).is_err());
        }
    }

    #[test]
    fn offset_addition_overflow_leaves_scope_state_unchanged() {
        let (mut state, room, _, _, remote, _) = state();
        state
            .set_scope_offsets(&room, UserOffsets::new(f64::MAX, 0.0).unwrap())
            .unwrap();
        let before = state.snapshot();
        let mapping = mapping(vec![
            MappingEntry::new(
                Gesture::Up,
                ScopeTarget::SelectedScope,
                Action::brightness_offset(f64::MAX).unwrap(),
            )
            .unwrap(),
        ]);

        assert_eq!(
            mapping.execute(&remote, Gesture::Up, &mut state, context()),
            Err(InputError::State(StateError::NonFinite))
        );
        assert_eq!(state.snapshot(), before);
    }

    #[test]
    fn selected_scope_actions_mutate_shared_scope_state() {
        let (mut state, room, _, _, remote_a, remote_b) = state();
        let mapping = mapping(vec![
            MappingEntry::new(
                Gesture::Up,
                ScopeTarget::SelectedScope,
                Action::brightness_offset(0.1).unwrap(),
            )
            .unwrap(),
            MappingEntry::new(
                Gesture::Left,
                ScopeTarget::SelectedScope,
                Action::color_temperature_offset(-250.0).unwrap(),
            )
            .unwrap(),
            MappingEntry::new(
                Gesture::Down,
                ScopeTarget::SelectedScope,
                Action::brightness_offset(-0.025).unwrap(),
            )
            .unwrap(),
            MappingEntry::new(
                Gesture::Right,
                ScopeTarget::SelectedScope,
                Action::color_temperature_offset(50.0).unwrap(),
            )
            .unwrap(),
            MappingEntry::new(
                Gesture::CenterSingle,
                ScopeTarget::SelectedScope,
                Action::TogglePower,
            )
            .unwrap(),
        ]);

        mapping
            .execute(&remote_a, Gesture::Up, &mut state, context())
            .unwrap();
        mapping
            .execute(&remote_a, Gesture::Left, &mut state, context())
            .unwrap();
        mapping
            .execute(&remote_a, Gesture::Down, &mut state, context())
            .unwrap();
        mapping
            .execute(&remote_a, Gesture::Right, &mut state, context())
            .unwrap();
        assert!(
            (state.scope_state(&room).unwrap().offsets().brightness() - 0.075).abs() < f64::EPSILON
        );
        assert_eq!(
            state
                .scope_state(&room)
                .unwrap()
                .offsets()
                .color_temperature_kelvin(),
            -200.0
        );
        assert_eq!(
            mapping
                .execute(&remote_b, Gesture::CenterSingle, &mut state, context())
                .unwrap(),
            Some(ActionOutcome::PowerToggled {
                scope: room.clone(),
                on: false,
            })
        );
        assert!(!state.scope_state(&room).unwrap().is_on());
    }

    #[test]
    fn explicit_room_floor_and_house_targets_resolve_independently() {
        let (mut state, room, floor, house, remote, _) = state();
        for (scope, gesture) in [
            (room.clone(), Gesture::Up),
            (floor.clone(), Gesture::Down),
            (house.clone(), Gesture::Right),
        ] {
            let mapping = mapping(vec![
                MappingEntry::new(
                    gesture,
                    ScopeTarget::Explicit(scope.clone()),
                    Action::brightness_offset(0.1).unwrap(),
                )
                .unwrap(),
            ]);
            mapping
                .execute(&remote, gesture, &mut state, context())
                .unwrap();
            assert_eq!(
                state.scope_state(&scope).unwrap().offsets().brightness(),
                0.1
            );
        }
    }

    #[test]
    fn selected_scope_change_survives_snapshot_restore() {
        let (mut state, _, floor, _, remote, _) = state();
        let mapping = mapping(vec![
            MappingEntry::new(
                Gesture::CenterLong,
                ScopeTarget::Explicit(floor.clone()),
                Action::SelectScope,
            )
            .unwrap(),
        ]);

        assert_eq!(
            mapping
                .execute(&remote, Gesture::CenterLong, &mut state, context())
                .unwrap(),
            Some(ActionOutcome::ScopeSelected {
                scope: floor.clone(),
            })
        );
        let restored = AutomationState::restore(state.snapshot()).unwrap();
        assert_eq!(
            restored.control_state(&remote).unwrap().selected_scope(),
            &floor
        );
    }

    #[test]
    fn select_scope_requires_explicit_target() {
        assert_eq!(
            MappingEntry::new(
                Gesture::CenterLong,
                ScopeTarget::SelectedScope,
                Action::SelectScope,
            ),
            Err(InputError::SelectScopeRequiresExplicitTarget)
        );
    }

    #[test]
    fn successful_circadian_toggle_returns_outcome_and_acknowledgement_request() {
        let (mut state, room, _, _, remote, _) = state();
        let settings =
            AcknowledgementSettings::new(OverlayId::new("circadian-ack").unwrap(), 0.1, 0.5, 100)
                .unwrap();
        let mapping = mapping(vec![
            MappingEntry::new(
                Gesture::CenterDouble,
                ScopeTarget::SelectedScope,
                Action::ToggleCircadian,
            )
            .unwrap(),
        ]);
        let context = ActionContext::default().with_toggle(
            ToggleContext::new(live_curve(), now(10.0), duration()).with_acknowledgement(&settings),
        );

        let outcome = mapping
            .execute(&remote, Gesture::CenterDouble, &mut state, context)
            .unwrap()
            .unwrap();
        let ActionOutcome::CircadianToggled {
            scope,
            outcome,
            acknowledgement,
        } = outcome
        else {
            panic!("wrong action outcome");
        };
        assert_eq!(scope, room);
        assert_eq!(outcome, CurveToggleOutcome::Frozen);
        let frozen_acknowledgement = acknowledgement.unwrap();
        assert_eq!(frozen_acknowledgement.kind(), AcknowledgementKind::Frozen);

        let unfreeze_context = ActionContext::default().with_toggle(
            ToggleContext::new(live_curve(), now(11.0), duration()).with_acknowledgement(&settings),
        );
        let unfreeze = mapping
            .execute(&remote, Gesture::CenterDouble, &mut state, unfreeze_context)
            .unwrap()
            .unwrap();
        let ActionOutcome::CircadianToggled {
            scope,
            outcome,
            acknowledgement,
        } = unfreeze
        else {
            panic!("wrong action outcome");
        };
        let unfrozen_acknowledgement = acknowledgement.unwrap();
        assert_eq!(scope, room);
        assert_eq!(outcome, CurveToggleOutcome::Unfrozen);
        assert_eq!(
            unfrozen_acknowledgement.kind(),
            AcknowledgementKind::Unfrozen
        );
        assert_ne!(frozen_acknowledgement, unfrozen_acknowledgement);
        assert!(matches!(
            state.scope_state(&room).unwrap().mode(),
            CurveMode::Converging { .. }
        ));
    }

    #[test]
    fn acknowledgement_uses_layers_from_resolved_scope() {
        let (mut state, kitchen, _, _, remote, _) = state();
        let bedroom = Scope::Room(id("bedroom"));
        state
            .insert_scope(bedroom.clone(), ScopeState::new(true))
            .unwrap();
        state
            .set_scope_offsets(&bedroom, UserOffsets::new(0.4, 0.0).unwrap())
            .unwrap();
        let range = KelvinRange::new(2_200.0, 6_500.0).unwrap();
        assert_eq!(
            state
                .compose_scope_target(&bedroom, live_curve(), now(10.0), range)
                .unwrap()
                .brightness
                .unwrap()
                .get(),
            0.8
        );
        let settings =
            AcknowledgementSettings::new(OverlayId::new("circadian-ack").unwrap(), 0.1, 0.5, 100)
                .unwrap();
        let mapping = mapping(vec![
            MappingEntry::new(
                Gesture::CenterDouble,
                ScopeTarget::Explicit(kitchen.clone()),
                Action::ToggleCircadian,
            )
            .unwrap(),
        ]);
        let context = ActionContext::default().with_toggle(
            ToggleContext::new(live_curve(), now(10.0), duration()).with_acknowledgement(&settings),
        );

        let outcome = mapping
            .execute(&remote, Gesture::CenterDouble, &mut state, context)
            .unwrap()
            .unwrap();
        let ActionOutcome::CircadianToggled {
            acknowledgement: Some(acknowledgement),
            ..
        } = outcome
        else {
            panic!("toggle did not return acknowledgement");
        };
        let kitchen_layers = state
            .compose_scope_layers(&kitchen, live_curve(), now(10.0))
            .unwrap();
        let mut overlays = OverlaySet::new();
        overlays
            .insert_request(acknowledgement.into_overlay(), now(10.0))
            .unwrap();
        let signalled = overlays.compose(kitchen_layers, now(10.1), range).unwrap();
        assert_eq!(signalled.brightness.unwrap().get(), 0.5);
    }

    #[test]
    fn circadian_toggle_without_toggle_context_fails_without_mutation() {
        let (mut state, room, _, _, remote, _) = state();
        let before = state.snapshot();
        let mapping = mapping(vec![
            MappingEntry::new(
                Gesture::CenterDouble,
                ScopeTarget::SelectedScope,
                Action::ToggleCircadian,
            )
            .unwrap(),
        ]);

        assert_eq!(
            mapping.execute(
                &remote,
                Gesture::CenterDouble,
                &mut state,
                ActionContext::default(),
            ),
            Err(InputError::MissingToggleContext)
        );
        assert_eq!(state.snapshot(), before);
        assert!(matches!(
            state.scope_state(&room).unwrap().mode(),
            CurveMode::Follow
        ));
    }

    #[test]
    fn failed_circadian_toggle_returns_no_outcome_or_acknowledgement_and_does_not_mutate() {
        let (mut state, room, _, _, remote, _) = state();
        state
            .toggle_scope_curve(&room, live_curve(), now(10.0), duration())
            .unwrap();
        state
            .toggle_scope_curve(&room, live_curve(), now(20.0), duration())
            .unwrap();
        let before = *state.scope_state(&room).unwrap().mode();
        state
            .compose_scope_layers(&room, live_curve(), now(20.0))
            .unwrap();
        let settings =
            AcknowledgementSettings::new(OverlayId::new("circadian-ack").unwrap(), 0.1, 0.5, 100)
                .unwrap();
        let mapping = mapping(vec![
            MappingEntry::new(
                Gesture::CenterDouble,
                ScopeTarget::SelectedScope,
                Action::ToggleCircadian,
            )
            .unwrap(),
        ]);
        let failed_context = ActionContext::default().with_toggle(
            ToggleContext::new(live_curve(), now(19.0), duration()).with_acknowledgement(&settings),
        );

        assert_eq!(
            mapping.execute(&remote, Gesture::CenterDouble, &mut state, failed_context,),
            Err(InputError::State(StateError::MonotonicClockRegressed))
        );
        assert_eq!(state.scope_state(&room).unwrap().mode(), &before);
    }

    #[test]
    fn unknown_control_and_scope_errors_propagate_without_partial_mutation() {
        let (mut state, room, _, _, remote, _) = state();
        let before = state.snapshot();
        let selected_mapping = mapping(vec![
            MappingEntry::new(
                Gesture::Up,
                ScopeTarget::SelectedScope,
                Action::brightness_offset(0.1).unwrap(),
            )
            .unwrap(),
        ]);
        assert_eq!(
            selected_mapping.execute(&control("missing"), Gesture::Up, &mut state, context()),
            Err(InputError::State(StateError::UnknownControl(control(
                "missing"
            ))))
        );

        let missing_scope = Scope::Room(id("missing"));
        let explicit_mapping = mapping(vec![
            MappingEntry::new(
                Gesture::Up,
                ScopeTarget::Explicit(missing_scope.clone()),
                Action::brightness_offset(0.1).unwrap(),
            )
            .unwrap(),
        ]);
        assert_eq!(
            explicit_mapping.execute(&remote, Gesture::Up, &mut state, context()),
            Err(InputError::State(StateError::UnknownScope(missing_scope)))
        );
        assert_eq!(state.snapshot(), before);
        assert_eq!(
            state.scope_state(&room).unwrap().offsets().brightness(),
            0.0
        );
    }

    #[test]
    fn missing_mapping_is_a_deterministic_no_op() {
        let (mut state, _, _, _, remote, _) = state();
        assert_eq!(
            Mapping::new(Vec::new())
                .unwrap()
                .execute(&remote, Gesture::Up, &mut state, context())
                .unwrap(),
            None
        );
    }

    #[test]
    fn frozen_and_converging_modes_are_distinct_for_test_precondition() {
        let (mut state, room, _, _, _, _) = state();
        state
            .toggle_scope_curve(&room, live_curve(), now(10.0), duration())
            .unwrap();
        assert!(matches!(
            state.scope_state(&room).unwrap().mode(),
            CurveMode::Frozen { .. }
        ));
    }
}
