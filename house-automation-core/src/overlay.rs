use std::{
    collections::BTreeMap,
    error::Error,
    fmt::{self, Display},
};

use crate::{
    state::{CurveToggleOutcome, MonotonicTime},
    value::{
        Brightness, Capabilities, Color, Kelvin, KelvinRange, LayeredLightTarget, LightTarget,
        ValueError,
    },
};

const MAX_OVERLAY_ID_LENGTH: usize = 64;
const MIN_ACKNOWLEDGEMENT_AMPLITUDE: f64 = 0.01;
const MAX_ACKNOWLEDGEMENT_AMPLITUDE: f64 = 0.25;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OverlayId(String);

impl OverlayId {
    pub fn new(value: impl Into<String>) -> Result<Self, OverlayError> {
        let value = value.into();
        let bytes = value.as_bytes();
        let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        let valid_inner = |byte: u8| valid_edge(byte) || byte == b'_' || byte == b'-';
        if bytes.is_empty()
            || bytes.len() > MAX_OVERLAY_ID_LENGTH
            || !valid_edge(bytes[0])
            || !valid_edge(bytes[bytes.len() - 1])
            || !bytes.iter().copied().all(valid_inner)
        {
            return Err(OverlayError::InvalidIdentifier);
        }

        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub struct OverlayDuration(f64);

impl OverlayDuration {
    pub fn from_seconds(seconds: f64) -> Result<Self, OverlayError> {
        if !seconds.is_finite() {
            return Err(OverlayError::NonFinite);
        }
        if seconds <= 0.0 {
            return Err(OverlayError::NonPositiveDuration);
        }
        Ok(Self(seconds))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OverlayEffect(OverlayEffectKind);

impl OverlayEffect {
    pub fn brightness_delta(delta: f64) -> Result<Self, OverlayError> {
        validate_finite(delta)?;
        Ok(Self(OverlayEffectKind::BrightnessDelta(delta)))
    }

    pub fn color_temperature_delta(delta_kelvin: f64) -> Result<Self, OverlayError> {
        validate_finite(delta_kelvin)?;
        Ok(Self(OverlayEffectKind::ColorTemperatureDelta(delta_kelvin)))
    }

    pub fn scene(
        brightness: Option<Brightness>,
        color_temperature: Option<Kelvin>,
        color: Option<Color>,
    ) -> Result<Self, OverlayError> {
        if brightness.is_none() && color_temperature.is_none() && color.is_none() {
            return Err(OverlayError::EmptyScene);
        }
        Ok(Self(OverlayEffectKind::Scene {
            brightness,
            color_temperature,
            color,
        }))
    }

    fn apply(self, target: &mut LayeredLightTarget) -> Result<(), OverlayError> {
        match self.0 {
            OverlayEffectKind::BrightnessDelta(delta) => {
                if let Some(brightness) = target.brightness {
                    target.brightness = Some(checked_add(brightness, delta)?);
                }
            }
            OverlayEffectKind::ColorTemperatureDelta(delta) => {
                if let Some(kelvin) = target.color_temperature_kelvin {
                    target.color_temperature_kelvin = Some(checked_add(kelvin, delta)?);
                }
            }
            OverlayEffectKind::Scene {
                brightness,
                color_temperature,
                color,
            } => {
                if let Some(brightness) = brightness {
                    target.brightness = Some(brightness.get());
                }
                // Color wins if a single scene supplies both. A later CCT-only scene
                // clears color, so insertion ordering remains explicit and deterministic.
                if let Some(color) = color {
                    target.color = Some(color);
                    target.color_temperature_kelvin = None;
                } else if let Some(color_temperature) = color_temperature {
                    target.color_temperature_kelvin = Some(color_temperature.get());
                    target.color = None;
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum OverlayEffectKind {
    BrightnessDelta(f64),
    ColorTemperatureDelta(f64),
    Scene {
        brightness: Option<Brightness>,
        color_temperature: Option<Kelvin>,
        color: Option<Color>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct OverlayRequest {
    id: OverlayId,
    effect: OverlayEffect,
    priority: i32,
    duration: OverlayDuration,
}

impl OverlayRequest {
    pub fn new(
        id: OverlayId,
        effect: OverlayEffect,
        priority: i32,
        duration: OverlayDuration,
    ) -> Self {
        Self {
            id,
            effect,
            priority,
            duration,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ActiveOverlay {
    effect: OverlayEffect,
    priority: i32,
    sequence: u64,
    expires_at: f64,
}

/// In-memory overlays ordered from lower to higher priority.
///
/// Equal-priority overlays apply in insertion order, so later sequences win
/// for absolute fields. Replacing a key assigns a new insertion sequence.
#[derive(Debug, Clone, PartialEq)]
pub struct OverlaySet {
    overlays: BTreeMap<OverlayId, ActiveOverlay>,
    next_sequence: u64,
    last_observed: Option<MonotonicTime>,
}

impl OverlaySet {
    pub fn new() -> Self {
        Self {
            overlays: BTreeMap::new(),
            next_sequence: 0,
            last_observed: None,
        }
    }

    /// Number of stored entries. Expired entries are pruned by [`Self::compose`].
    pub fn stored_count(&self) -> usize {
        self.overlays.len()
    }

    pub fn next_expiry(&self) -> Option<MonotonicTime> {
        self.overlays
            .values()
            .map(|overlay| overlay.expires_at)
            .min_by(f64::total_cmp)
            .map(|seconds| {
                MonotonicTime::from_seconds(seconds)
                    .expect("validated overlay expiry is finite and nonnegative")
            })
    }

    pub fn insert(
        &mut self,
        id: OverlayId,
        effect: OverlayEffect,
        priority: i32,
        now: MonotonicTime,
        duration: OverlayDuration,
    ) -> Result<(), OverlayError> {
        self.validate_monotonic(now)?;
        let expires_at =
            checked_add(now.seconds(), duration.0).map_err(|_| OverlayError::ExpiryOverflow)?;
        let sequence = self.next_sequence;
        let next_sequence = sequence
            .checked_add(1)
            .ok_or(OverlayError::SequenceExhausted)?;

        self.overlays.insert(
            id,
            ActiveOverlay {
                effect,
                priority,
                sequence,
                expires_at,
            },
        );
        self.next_sequence = next_sequence;
        self.last_observed = Some(now);
        Ok(())
    }

    pub fn insert_request(
        &mut self,
        request: OverlayRequest,
        now: MonotonicTime,
    ) -> Result<(), OverlayError> {
        self.insert(
            request.id,
            request.effect,
            request.priority,
            now,
            request.duration,
        )
    }

    pub fn cancel(&mut self, id: &OverlayId) -> bool {
        self.overlays.remove(id).is_some()
    }

    pub fn compose(
        &mut self,
        mut underlying: LayeredLightTarget,
        now: MonotonicTime,
        color_temperature_range: KelvinRange,
    ) -> Result<LightTarget, OverlayError> {
        self.validate_monotonic(now)?;
        self.overlays
            .retain(|_, overlay| overlay.expires_at > now.seconds());
        self.last_observed = Some(now);

        let mut ordered: Vec<_> = self.overlays.values().collect();
        ordered.sort_by_key(|overlay| (overlay.priority, overlay.sequence));
        for overlay in ordered {
            overlay.effect.apply(&mut underlying)?;
        }

        underlying
            .finalize(color_temperature_range)
            .map_err(OverlayError::InvalidValue)
    }

    fn validate_monotonic(&self, now: MonotonicTime) -> Result<(), OverlayError> {
        if self.last_observed.is_some_and(|previous| now < previous) {
            return Err(OverlayError::MonotonicClockRegressed);
        }
        Ok(())
    }
}

impl Default for OverlaySet {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcknowledgementKind {
    Frozen,
    Unfrozen,
}

impl From<CurveToggleOutcome> for AcknowledgementKind {
    fn from(value: CurveToggleOutcome) -> Self {
        match value {
            CurveToggleOutcome::Frozen => Self::Frozen,
            CurveToggleOutcome::Unfrozen => Self::Unfrozen,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcknowledgementSettings {
    id: OverlayId,
    amplitude: f64,
    duration: OverlayDuration,
    priority: i32,
}

impl AcknowledgementSettings {
    pub fn new(
        id: OverlayId,
        amplitude: f64,
        duration_seconds: f64,
        priority: i32,
    ) -> Result<Self, OverlayError> {
        validate_finite(amplitude)?;
        if !(MIN_ACKNOWLEDGEMENT_AMPLITUDE..=MAX_ACKNOWLEDGEMENT_AMPLITUDE).contains(&amplitude) {
            return Err(OverlayError::AmplitudeOutOfRange);
        }
        Ok(Self {
            id,
            amplitude,
            duration: OverlayDuration::from_seconds(duration_seconds)?,
            priority,
        })
    }

    pub fn for_toggle(
        &self,
        outcome: CurveToggleOutcome,
        target: &LayeredLightTarget,
        capabilities: Capabilities,
    ) -> Option<AcknowledgementRequest> {
        if !capabilities.dimming {
            return None;
        }
        self.for_scope_toggle(outcome, target)
    }

    /// Build one scope-level pulse. Device adaptation later omits brightness
    /// for members without dimming support.
    pub fn for_scope_toggle(
        &self,
        outcome: CurveToggleOutcome,
        target: &LayeredLightTarget,
    ) -> Option<AcknowledgementRequest> {
        if !target.on {
            return None;
        }
        let brightness = target.brightness?.clamp(0.0, 1.0);
        let primary_delta = if brightness <= 0.5 {
            self.amplitude
        } else {
            -self.amplitude
        };
        let frozen_target = (brightness + primary_delta).clamp(0.0, 1.0);
        let opposite_target = brightness - primary_delta;
        let unfrozen_target = if (0.0..=1.0).contains(&opposite_target) {
            opposite_target
        } else {
            (brightness + 2.0 * primary_delta).clamp(0.0, 1.0)
        };
        let pulse_target = match outcome {
            CurveToggleOutcome::Frozen => frozen_target,
            CurveToggleOutcome::Unfrozen => unfrozen_target,
        };

        Some(AcknowledgementRequest {
            kind: outcome.into(),
            overlay: OverlayRequest::new(
                self.id.clone(),
                OverlayEffect::scene(
                    Some(
                        Brightness::new(pulse_target)
                            .expect("clamped acknowledgement target is normalized"),
                    ),
                    None,
                    None,
                )
                .expect("acknowledgement scene always contains brightness"),
                self.priority,
                self.duration,
            ),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcknowledgementRequest {
    kind: AcknowledgementKind,
    overlay: OverlayRequest,
}

impl AcknowledgementRequest {
    pub fn kind(&self) -> AcknowledgementKind {
        self.kind
    }

    pub fn into_overlay(self) -> OverlayRequest {
        self.overlay
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum OverlayError {
    InvalidIdentifier,
    NonFinite,
    NonPositiveDuration,
    AmplitudeOutOfRange,
    EmptyScene,
    ExpiryOverflow,
    MonotonicClockRegressed,
    SequenceExhausted,
    InvalidValue(ValueError),
}

impl Display for OverlayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier => formatter.write_str(
                "overlay identifier must be 1..=64 ASCII lowercase letters/digits with internal '_' or '-'",
            ),
            Self::NonFinite => formatter.write_str("overlay value must be finite"),
            Self::NonPositiveDuration => {
                formatter.write_str("overlay duration must be greater than zero")
            }
            Self::AmplitudeOutOfRange => formatter.write_str(
                "acknowledgement amplitude must be between 0.01 and 0.25 inclusive",
            ),
            Self::EmptyScene => formatter.write_str("overlay scene must set at least one field"),
            Self::ExpiryOverflow => formatter.write_str("overlay expiry exceeds monotonic range"),
            Self::MonotonicClockRegressed => formatter.write_str("monotonic clock regressed"),
            Self::SequenceExhausted => formatter.write_str("overlay insertion sequence exhausted"),
            Self::InvalidValue(error) => write!(formatter, "invalid composed overlay value: {error}"),
        }
    }
}

impl Error for OverlayError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidValue(error) => Some(error),
            _ => None,
        }
    }
}

fn validate_finite(value: f64) -> Result<(), OverlayError> {
    if !value.is_finite() {
        return Err(OverlayError::NonFinite);
    }
    Ok(())
}

fn checked_add(left: f64, right: f64) -> Result<f64, OverlayError> {
    let result = left + right;
    validate_finite(result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use crate::{
        state::{AutomationState, CurveToggleOutcome, MonotonicTime},
        value::{Brightness, Capabilities, Color, Kelvin, KelvinRange, LayeredLightTarget},
    };

    use super::{
        AcknowledgementKind, AcknowledgementSettings, OverlayDuration, OverlayEffect, OverlayError,
        OverlayId, OverlaySet,
    };

    fn now(seconds: f64) -> MonotonicTime {
        MonotonicTime::from_seconds(seconds).unwrap()
    }

    fn range() -> KelvinRange {
        KelvinRange::new(2_200.0, 6_500.0).unwrap()
    }

    fn layers(on: bool, brightness: Option<f64>, kelvin: Option<f64>) -> LayeredLightTarget {
        LayeredLightTarget::new(on, brightness, kelvin, None, None).unwrap()
    }

    fn id(value: &str) -> OverlayId {
        OverlayId::new(value).unwrap()
    }

    fn full_capabilities(dimming: bool) -> Capabilities {
        Capabilities {
            on_off: true,
            dimming,
            color_temperature: Some(range()),
            color_xy: true,
            color_hs: true,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        }
    }

    #[test]
    fn overlays_apply_before_the_only_final_clamp() {
        let mut overlays = OverlaySet::default();
        overlays
            .insert(
                id("signal"),
                OverlayEffect::brightness_delta(-0.2).unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();
        overlays
            .insert(
                id("warmer"),
                OverlayEffect::color_temperature_delta(-500.0).unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();

        let composed = overlays
            .compose(layers(true, Some(1.2), Some(6_000.0)), now(1.0), range())
            .unwrap();

        assert_eq!(composed.brightness.unwrap().get(), 1.0);
        assert_eq!(composed.color_temperature.unwrap().get(), 5_500.0);
    }

    #[test]
    fn expiry_boundary_discards_overlay_and_recomputes_current_underlying_target() {
        let mut overlays = OverlaySet::new();
        overlays
            .insert(
                id("hourly"),
                OverlayEffect::brightness_delta(0.2).unwrap(),
                0,
                now(10.0),
                OverlayDuration::from_seconds(5.0).unwrap(),
            )
            .unwrap();

        let during = overlays
            .compose(layers(true, Some(0.4), None), now(14.999), range())
            .unwrap();
        assert!((during.brightness.unwrap().get() - 0.6).abs() < 1e-12);

        let expired = overlays
            .compose(layers(true, Some(0.7), None), now(15.0), range())
            .unwrap();
        assert_eq!(expired.brightness.unwrap().get(), 0.7);
        assert_eq!(overlays.stored_count(), 0);
    }

    #[test]
    fn same_key_replaces_effect_expiry_and_insertion_position() {
        let mut overlays = OverlaySet::new();
        let key = id("notification");
        overlays
            .insert(
                key.clone(),
                OverlayEffect::scene(Some(Brightness::new(0.2).unwrap()), None, None).unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(1.0).unwrap(),
            )
            .unwrap();
        overlays
            .insert(
                id("between"),
                OverlayEffect::brightness_delta(0.1).unwrap(),
                0,
                now(0.25),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();
        overlays
            .insert(
                key,
                OverlayEffect::scene(Some(Brightness::new(0.3).unwrap()), None, None).unwrap(),
                0,
                now(0.5),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();

        let composed = overlays
            .compose(layers(true, Some(0.5), None), now(2.0), range())
            .unwrap();
        assert_eq!(composed.brightness.unwrap().get(), 0.3);
        assert_eq!(overlays.stored_count(), 2);
    }

    #[test]
    fn distinct_overlays_compose_by_priority_then_insertion_sequence() {
        let mut overlays = OverlaySet::new();
        overlays
            .insert(
                id("absolute-high"),
                OverlayEffect::scene(Some(Brightness::new(0.8).unwrap()), None, None).unwrap(),
                10,
                now(0.0),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();
        overlays
            .insert(
                id("absolute-low"),
                OverlayEffect::scene(Some(Brightness::new(0.3).unwrap()), None, None).unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();
        overlays
            .insert(
                id("same-priority-later"),
                OverlayEffect::brightness_delta(0.2).unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();

        let composed = overlays
            .compose(layers(true, Some(0.1), None), now(1.0), range())
            .unwrap();
        assert_eq!(composed.brightness.unwrap().get(), 0.8);
    }

    #[test]
    fn cancellation_removes_only_the_selected_overlay() {
        let mut overlays = OverlaySet::new();
        for (key, delta) in [("first", 0.1), ("second", 0.2)] {
            overlays
                .insert(
                    id(key),
                    OverlayEffect::brightness_delta(delta).unwrap(),
                    0,
                    now(0.0),
                    OverlayDuration::from_seconds(10.0).unwrap(),
                )
                .unwrap();
        }

        assert!(overlays.cancel(&id("first")));
        assert!(!overlays.cancel(&id("missing")));
        let composed = overlays
            .compose(layers(true, Some(0.3), None), now(1.0), range())
            .unwrap();
        assert_eq!(composed.brightness.unwrap().get(), 0.5);
    }

    #[test]
    fn absolute_color_and_temperature_scenes_have_explicit_mutual_precedence() {
        let mut color_overlays = OverlaySet::new();
        let color = Color::xy(0.25, 0.4).unwrap();
        color_overlays
            .insert(
                id("color"),
                OverlayEffect::scene(None, Some(Kelvin::new(2_700.0).unwrap()), Some(color))
                    .unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();
        let color_target = color_overlays
            .compose(layers(true, Some(0.5), Some(4_000.0)), now(1.0), range())
            .unwrap();
        assert_eq!(color_target.color, Some(color));
        assert_eq!(color_target.color_temperature, None);

        let mut temperature_overlays = OverlaySet::new();
        temperature_overlays
            .insert(
                id("first-color"),
                OverlayEffect::scene(None, None, Some(color)).unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();
        temperature_overlays
            .insert(
                id("later-temperature"),
                OverlayEffect::scene(None, Some(Kelvin::new(3_200.0).unwrap()), None).unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(10.0).unwrap(),
            )
            .unwrap();
        let temperature_target = temperature_overlays
            .compose(layers(true, Some(0.5), None), now(1.0), range())
            .unwrap();
        assert_eq!(temperature_target.color, None);
        assert_eq!(temperature_target.color_temperature.unwrap().get(), 3_200.0);
    }

    #[test]
    fn overlay_inputs_expiry_math_and_clock_regression_fail_explicitly() {
        assert!(OverlayId::new("bad/key").is_err());
        assert_eq!(id("hourly-signal").as_str(), "hourly-signal");
        for invalid in [f64::NAN, f64::NEG_INFINITY, f64::INFINITY] {
            assert!(OverlayEffect::brightness_delta(invalid).is_err());
            assert!(OverlayEffect::color_temperature_delta(invalid).is_err());
            assert!(OverlayDuration::from_seconds(invalid).is_err());
        }
        assert!(OverlayDuration::from_seconds(0.0).is_err());
        assert!(OverlayDuration::from_seconds(-1.0).is_err());
        assert!(OverlayEffect::scene(None, None, None).is_err());

        let mut overflow = OverlaySet::new();
        assert_eq!(
            overflow.insert(
                id("overflow"),
                OverlayEffect::brightness_delta(0.1).unwrap(),
                0,
                now(f64::MAX),
                OverlayDuration::from_seconds(f64::MAX).unwrap(),
            ),
            Err(OverlayError::ExpiryOverflow)
        );

        let mut regressed = OverlaySet::new();
        regressed
            .insert(
                id("clock"),
                OverlayEffect::brightness_delta(0.1).unwrap(),
                0,
                now(5.0),
                OverlayDuration::from_seconds(1.0).unwrap(),
            )
            .unwrap();
        assert_eq!(
            regressed.compose(layers(true, Some(0.5), None), now(4.0), range()),
            Err(OverlayError::MonotonicClockRegressed)
        );
    }

    #[test]
    fn insertion_sequence_exhaustion_never_wraps_or_mutates_existing_entries() {
        let mut overlays = OverlaySet::new();
        overlays.next_sequence = u64::MAX;
        assert_eq!(
            overlays.insert(
                id("overflow"),
                OverlayEffect::brightness_delta(0.1).unwrap(),
                0,
                now(0.0),
                OverlayDuration::from_seconds(1.0).unwrap(),
            ),
            Err(OverlayError::SequenceExhausted)
        );
        assert_eq!(overlays.stored_count(), 0);
    }

    #[test]
    fn acknowledgement_kinds_choose_distinct_absolute_targets_at_boundaries() {
        let settings = AcknowledgementSettings::new(id("circadian-ack"), 0.1, 0.5, 100).unwrap();
        for (starting, expected_frozen, expected_unfrozen) in [
            (0.0, 0.1, 0.2),
            (0.05, 0.15, 0.25),
            (0.5, 0.6, 0.4),
            (0.95, 0.85, 0.75),
            (1.0, 0.9, 0.8),
        ] {
            for (outcome, expected) in [
                (CurveToggleOutcome::Frozen, expected_frozen),
                (CurveToggleOutcome::Unfrozen, expected_unfrozen),
            ] {
                let underlying = layers(true, Some(starting), None);
                let request = settings
                    .for_toggle(outcome, &underlying, full_capabilities(true))
                    .unwrap();
                let mut overlays = OverlaySet::new();
                overlays
                    .insert_request(request.into_overlay(), now(0.0))
                    .unwrap();
                let composed = overlays.compose(underlying, now(0.1), range()).unwrap();
                assert!(
                    (composed.brightness.unwrap().get() - expected).abs() < 1e-12,
                    "starting {starting}, outcome {outcome:?}"
                );
                assert!(composed.on);
            }
        }
    }

    #[test]
    fn acknowledgement_targets_remain_distinct_for_adversarial_brightness_values() {
        let settings = AcknowledgementSettings::new(id("circadian-ack"), 0.25, 0.5, 100).unwrap();
        for starting in [
            f64::from_bits(0.0_f64.to_bits() + 1),
            0.499_999_999_999_999_94,
            f64::from_bits(0.5_f64.to_bits() + 1),
            f64::from_bits(1.0_f64.to_bits() - 1),
        ] {
            let mut outputs = Vec::new();
            for outcome in [CurveToggleOutcome::Frozen, CurveToggleOutcome::Unfrozen] {
                let underlying = layers(true, Some(starting), None);
                let request = settings
                    .for_toggle(outcome, &underlying, full_capabilities(true))
                    .unwrap();
                let mut overlays = OverlaySet::new();
                overlays
                    .insert_request(request.into_overlay(), now(0.0))
                    .unwrap();
                outputs.push(
                    overlays
                        .compose(underlying, now(0.1), range())
                        .unwrap()
                        .brightness
                        .unwrap()
                        .get(),
                );
            }
            assert!(outputs.iter().all(|value| value.is_finite()));
            assert!(
                outputs
                    .iter()
                    .all(|value| *value != starting.clamp(0.0, 1.0)),
                "starting {starting}"
            );
            assert_ne!(outputs[0], outputs[1], "starting {starting}");
        }
    }

    #[test]
    fn acknowledgement_is_visible_when_raw_brightness_is_outside_final_bounds() {
        let settings = AcknowledgementSettings::new(id("circadian-ack"), 0.1, 0.5, 100).unwrap();
        for (raw, normal, acknowledged) in [(1.2, 1.0, 0.9), (-0.2, 0.0, 0.1)] {
            let underlying = layers(true, Some(raw), None);
            let normal_target = underlying.finalize(range()).unwrap();
            assert_eq!(normal_target.brightness.unwrap().get(), normal);

            let request = settings
                .for_toggle(
                    CurveToggleOutcome::Frozen,
                    &underlying,
                    full_capabilities(true),
                )
                .unwrap();
            let mut overlays = OverlaySet::new();
            overlays
                .insert_request(request.into_overlay(), now(0.0))
                .unwrap();
            let signalled = overlays.compose(underlying, now(0.1), range()).unwrap();
            assert_eq!(signalled.brightness.unwrap().get(), acknowledged);
            assert_ne!(signalled.brightness, normal_target.brightness);
        }
    }

    #[test]
    fn acknowledgement_never_flashes_off_or_non_dimmable_targets() {
        let settings = AcknowledgementSettings::new(id("circadian-ack"), 0.1, 0.5, 100).unwrap();

        assert!(
            settings
                .for_toggle(
                    CurveToggleOutcome::Frozen,
                    &layers(false, Some(0.5), None),
                    full_capabilities(true),
                )
                .is_none()
        );
        assert!(
            settings
                .for_toggle(
                    CurveToggleOutcome::Frozen,
                    &layers(true, Some(0.5), None),
                    full_capabilities(false),
                )
                .is_none()
        );
        assert!(
            settings
                .for_toggle(
                    CurveToggleOutcome::Frozen,
                    &layers(true, None, None),
                    full_capabilities(true),
                )
                .is_none()
        );
    }

    #[test]
    fn successful_freeze_and_unfreeze_acknowledgements_are_distinct_and_replace() {
        let settings = AcknowledgementSettings::new(id("circadian-ack"), 0.1, 0.5, 100).unwrap();
        let freeze = settings
            .for_toggle(
                CurveToggleOutcome::Frozen,
                &layers(true, Some(0.5), None),
                full_capabilities(true),
            )
            .unwrap();
        let unfreeze = settings
            .for_toggle(
                CurveToggleOutcome::Unfrozen,
                &layers(true, Some(0.5), None),
                full_capabilities(true),
            )
            .unwrap();
        assert_eq!(freeze.kind(), AcknowledgementKind::Frozen);
        assert_eq!(unfreeze.kind(), AcknowledgementKind::Unfrozen);

        let mut overlays = OverlaySet::new();
        overlays
            .insert_request(freeze.into_overlay(), now(0.0))
            .unwrap();
        let frozen = overlays
            .compose(layers(true, Some(0.5), None), now(0.05), range())
            .unwrap();
        assert_eq!(frozen.brightness.unwrap().get(), 0.6);
        overlays
            .insert_request(unfreeze.into_overlay(), now(0.1))
            .unwrap();
        assert_eq!(overlays.stored_count(), 1);
        let unfrozen = overlays
            .compose(layers(true, Some(0.5), None), now(0.11), range())
            .unwrap();
        assert_eq!(unfrozen.brightness.unwrap().get(), 0.4);
        let expired = overlays
            .compose(layers(true, Some(0.4), None), now(0.6), range())
            .unwrap();
        assert_eq!(expired.brightness.unwrap().get(), 0.4);
    }

    #[test]
    fn acknowledgement_settings_reject_invalid_amplitude_and_duration() {
        const MINIMUM: f64 = 0.01;
        const MAXIMUM: f64 = 0.25;
        assert!(AcknowledgementSettings::new(id("circadian-ack"), MINIMUM, 0.5, 100).is_ok());
        assert!(AcknowledgementSettings::new(id("circadian-ack"), MAXIMUM, 0.5, 100).is_ok());
        for amplitude in [
            0.0,
            -0.1,
            f64::NAN,
            f64::INFINITY,
            f64::from_bits(MINIMUM.to_bits() - 1),
            f64::from_bits(MAXIMUM.to_bits() + 1),
        ] {
            assert!(
                AcknowledgementSettings::new(id("circadian-ack"), amplitude, 0.5, 100).is_err()
            );
        }
        assert!(AcknowledgementSettings::new(id("circadian-ack"), 0.1, 0.0, 100).is_err());
        assert_eq!(
            AcknowledgementSettings::new(id("circadian-ack"), 0.251, 0.5, 100),
            Err(OverlayError::AmplitudeOutOfRange)
        );
    }

    #[test]
    fn durable_automation_snapshot_has_no_overlay_collection_or_progress() {
        let encoded = serde_json::to_value(AutomationState::default().snapshot()).unwrap();
        let Value::Object(fields) = encoded else {
            panic!("snapshot must be an object");
        };
        assert!(!fields.contains_key("overlays"));
        assert!(!fields.contains_key("overlay_progress"));
    }
}
