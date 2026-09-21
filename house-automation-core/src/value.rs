use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};

const NORMALIZED_MIN: f64 = 0.0;
const NORMALIZED_MAX: f64 = 1.0;
const HUE_MIN: f64 = 0.0;
const HUE_MAX: f64 = 360.0;
const MIRED_SCALE: f64 = 1_000_000.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ValueError {
    NonFinite,
    OutOfRange { minimum: f64, maximum: f64 },
    NonPositiveKelvin,
    UnrepresentableMired,
    InvalidKelvinRange,
}

impl fmt::Display for ValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFinite => formatter.write_str("value must be finite"),
            Self::OutOfRange { minimum, maximum } => {
                write!(formatter, "value must be between {minimum} and {maximum}")
            }
            Self::NonPositiveKelvin => formatter.write_str("Kelvin value must be positive"),
            Self::UnrepresentableMired => {
                formatter.write_str("Kelvin value must have a finite mired representation")
            }
            Self::InvalidKelvinRange => {
                formatter.write_str("Kelvin range minimum must not exceed its maximum")
            }
        }
    }
}

impl Error for ValueError {}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct Brightness(f64);

impl Brightness {
    pub fn new(value: f64) -> Result<Self, ValueError> {
        validate_finite_range(value, NORMALIZED_MIN, NORMALIZED_MAX).map(Self)
    }

    pub fn clamped(value: f64) -> Result<Self, ValueError> {
        if !value.is_finite() {
            return Err(ValueError::NonFinite);
        }

        Ok(Self(value.clamp(NORMALIZED_MIN, NORMALIZED_MAX)))
    }

    pub fn get(self) -> f64 {
        self.0
    }

    pub fn with_offset(self, offset: f64) -> Result<Self, ValueError> {
        if !offset.is_finite() {
            return Err(ValueError::NonFinite);
        }

        Self::clamped(self.0 + offset)
    }
}

impl TryFrom<f64> for Brightness {
    type Error = ValueError;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<Brightness> for f64 {
    fn from(value: Brightness) -> Self {
        value.get()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct Kelvin(f64);

impl Kelvin {
    pub fn new(value: f64) -> Result<Self, ValueError> {
        if !value.is_finite() {
            return Err(ValueError::NonFinite);
        }
        if value <= 0.0 {
            return Err(ValueError::NonPositiveKelvin);
        }
        if !(MIRED_SCALE / value).is_finite() {
            return Err(ValueError::UnrepresentableMired);
        }

        Ok(Self(value))
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for Kelvin {
    type Error = ValueError;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<Kelvin> for f64 {
    fn from(value: Kelvin) -> Self {
        value.get()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "KelvinRangeRepr", into = "KelvinRangeRepr")]
pub struct KelvinRange {
    min: Kelvin,
    max: Kelvin,
}

impl KelvinRange {
    pub fn new(min: f64, max: f64) -> Result<Self, ValueError> {
        let min = Kelvin::new(min)?;
        let max = Kelvin::new(max)?;
        if min > max {
            return Err(ValueError::InvalidKelvinRange);
        }

        Ok(Self { min, max })
    }

    pub fn min(self) -> Kelvin {
        self.min
    }

    pub fn max(self) -> Kelvin {
        self.max
    }

    pub fn clamp(self, kelvin: Kelvin) -> Kelvin {
        Kelvin(kelvin.get().clamp(self.min.get(), self.max.get()))
    }

    pub fn with_offset(self, kelvin: Kelvin, offset: f64) -> Result<Kelvin, ValueError> {
        if !offset.is_finite() {
            return Err(ValueError::NonFinite);
        }

        let adjusted = kelvin.get() + offset;
        if !adjusted.is_finite() {
            return Err(ValueError::NonFinite);
        }

        Ok(Kelvin(adjusted.clamp(self.min.get(), self.max.get())))
    }
}

#[derive(Serialize, Deserialize)]
struct KelvinRangeRepr {
    min: f64,
    max: f64,
}

impl TryFrom<KelvinRangeRepr> for KelvinRange {
    type Error = ValueError;

    fn try_from(value: KelvinRangeRepr) -> Result<Self, Self::Error> {
        Self::new(value.min, value.max)
    }
}

impl From<KelvinRange> for KelvinRangeRepr {
    fn from(value: KelvinRange) -> Self {
        Self {
            min: value.min().get(),
            max: value.max().get(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "ColorRepr", into = "ColorRepr")]
pub struct Color(ColorValue);

impl Color {
    pub fn xy(x: f64, y: f64) -> Result<Self, ValueError> {
        validate_finite_range(x, NORMALIZED_MIN, NORMALIZED_MAX)?;
        validate_finite_range(y, NORMALIZED_MIN, NORMALIZED_MAX)?;
        Ok(Self(ColorValue::Xy { x, y }))
    }

    pub fn hs(hue: f64, saturation: f64) -> Result<Self, ValueError> {
        validate_finite_range(hue, HUE_MIN, HUE_MAX)?;
        validate_finite_range(saturation, NORMALIZED_MIN, NORMALIZED_MAX)?;
        Ok(Self(ColorValue::Hs { hue, saturation }))
    }

    pub fn xy_components(self) -> Option<(f64, f64)> {
        match self.0 {
            ColorValue::Xy { x, y } => Some((x, y)),
            ColorValue::Hs { .. } => None,
        }
    }

    pub fn hs_components(self) -> Option<(f64, f64)> {
        match self.0 {
            ColorValue::Xy { .. } => None,
            ColorValue::Hs { hue, saturation } => Some((hue, saturation)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ColorValue {
    Xy { x: f64, y: f64 },
    Hs { hue: f64, saturation: f64 },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ColorRepr {
    Xy { x: f64, y: f64 },
    Hs { hue: f64, saturation: f64 },
}

impl TryFrom<ColorRepr> for Color {
    type Error = ValueError;

    fn try_from(value: ColorRepr) -> Result<Self, Self::Error> {
        match value {
            ColorRepr::Xy { x, y } => Self::xy(x, y),
            ColorRepr::Hs { hue, saturation } => Self::hs(hue, saturation),
        }
    }
}

impl From<Color> for ColorRepr {
    fn from(value: Color) -> Self {
        match value.0 {
            ColorValue::Xy { x, y } => Self::Xy { x, y },
            ColorValue::Hs { hue, saturation } => Self::Hs { hue, saturation },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LightTarget {
    pub on: bool,
    pub brightness: Option<Brightness>,
    pub color_temperature: Option<Kelvin>,
    pub color: Option<Color>,
    pub transition_ms: Option<u64>,
}

/// Finite lighting layers before device bounds are applied.
///
/// Keeping this intermediate unclamped lets later layers compensate for an
/// earlier offset before the final device target is bounded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayeredLightTarget {
    pub(crate) on: bool,
    pub(crate) brightness: Option<f64>,
    pub(crate) color_temperature_kelvin: Option<f64>,
    pub(crate) color: Option<Color>,
    pub(crate) transition_ms: Option<u64>,
}

impl LayeredLightTarget {
    pub(crate) fn new(
        on: bool,
        brightness: Option<f64>,
        color_temperature_kelvin: Option<f64>,
        color: Option<Color>,
        transition_ms: Option<u64>,
    ) -> Result<Self, ValueError> {
        if brightness.is_some_and(|value| !value.is_finite())
            || color_temperature_kelvin.is_some_and(|value| !value.is_finite())
        {
            return Err(ValueError::NonFinite);
        }

        Ok(Self {
            on,
            brightness,
            color_temperature_kelvin,
            color,
            transition_ms,
        })
    }

    pub fn brightness(self) -> Option<f64> {
        self.brightness
    }

    pub fn color_temperature_kelvin(self) -> Option<f64> {
        self.color_temperature_kelvin
    }

    pub fn finalize(self, color_temperature_range: KelvinRange) -> Result<LightTarget, ValueError> {
        let brightness = self.brightness.map(Brightness::clamped).transpose()?;
        let color_temperature = if self.color.is_some() {
            None
        } else {
            self.color_temperature_kelvin
                .map(|kelvin| {
                    Kelvin::new(kelvin.clamp(
                        color_temperature_range.min().get(),
                        color_temperature_range.max().get(),
                    ))
                })
                .transpose()?
        };

        Ok(LightTarget {
            on: self.on,
            brightness,
            color_temperature,
            color: self.color,
            transition_ms: self.transition_ms,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DeviceTarget {
    pub on: Option<bool>,
    pub brightness: Option<Brightness>,
    pub color_temperature: Option<Kelvin>,
    pub color: Option<Color>,
    pub transition_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Capabilities {
    pub on_off: bool,
    pub dimming: bool,
    pub color_temperature: Option<KelvinRange>,
    pub color_xy: bool,
    pub color_hs: bool,
    pub input: bool,
    pub occupancy: bool,
    pub temperature: bool,
    pub power_metering: bool,
}

impl Capabilities {
    pub fn degrade(self, target: &LightTarget) -> DeviceTarget {
        let on = self.on_off.then_some(target.on);
        let brightness = if self.dimming {
            target.brightness
        } else {
            None
        };
        let color = target.color.filter(|color| {
            (self.color_xy && color.xy_components().is_some())
                || (self.color_hs && color.hs_components().is_some())
        });
        let color_temperature = if color.is_none() {
            self.color_temperature
                .zip(target.color_temperature)
                .map(|(range, kelvin)| range.clamp(kelvin))
        } else {
            None
        };
        let transition_ms =
            if brightness.is_some() || color_temperature.is_some() || color.is_some() {
                target.transition_ms
            } else {
                None
            };

        DeviceTarget {
            on,
            brightness,
            color_temperature,
            color,
            transition_ms,
        }
    }
}

fn validate_finite_range(value: f64, minimum: f64, maximum: f64) -> Result<f64, ValueError> {
    if !value.is_finite() {
        return Err(ValueError::NonFinite);
    }
    if !(minimum..=maximum).contains(&value) {
        return Err(ValueError::OutOfRange { minimum, maximum });
    }

    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::fmt::Debug;

    use serde::{
        Deserialize, Serialize,
        de::{DeserializeOwned, value::F64Deserializer},
    };

    use super::{Brightness, Capabilities, Color, DeviceTarget, Kelvin, KelvinRange, LightTarget};

    fn assert_json_round_trip<T>(value: T)
    where
        T: Serialize + DeserializeOwned + Debug + PartialEq,
    {
        let encoded = serde_json::to_string(&value).unwrap();
        assert_eq!(serde_json::from_str::<T>(&encoded).unwrap(), value);
    }

    #[test]
    fn brightness_rejects_non_finite_and_out_of_range_values() {
        for value in [f64::NAN, f64::NEG_INFINITY, f64::INFINITY, -0.01, 1.01] {
            assert!(Brightness::new(value).is_err(), "accepted {value}");
        }

        assert_eq!(Brightness::new(0.0).unwrap().get(), 0.0);
        assert_eq!(Brightness::new(1.0).unwrap().get(), 1.0);
    }

    #[test]
    fn brightness_clamped_bounds_finite_values() {
        assert_eq!(Brightness::clamped(-0.5).unwrap().get(), 0.0);
        assert_eq!(Brightness::clamped(1.5).unwrap().get(), 1.0);
    }

    #[test]
    fn brightness_clamped_rejects_non_finite_values() {
        for value in [f64::NAN, f64::NEG_INFINITY, f64::INFINITY] {
            assert!(Brightness::clamped(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn brightness_offset_is_clamped_to_normalized_bounds() {
        let brightness = Brightness::new(0.4).unwrap();

        assert!((brightness.with_offset(0.2).unwrap().get() - 0.6).abs() < f64::EPSILON);
        assert_eq!(brightness.with_offset(-0.8).unwrap().get(), 0.0);
        assert_eq!(brightness.with_offset(0.8).unwrap().get(), 1.0);
        assert_eq!(brightness.with_offset(f64::MAX).unwrap().get(), 1.0);
    }

    #[test]
    fn brightness_offset_rejects_non_finite_values() {
        let brightness = Brightness::new(0.4).unwrap();

        for offset in [f64::NAN, f64::NEG_INFINITY, f64::INFINITY] {
            assert!(brightness.with_offset(offset).is_err(), "accepted {offset}");
        }
    }

    #[test]
    fn kelvin_and_kelvin_ranges_validate_their_bounds() {
        for value in [
            f64::NAN,
            f64::NEG_INFINITY,
            f64::INFINITY,
            -1.0,
            0.0,
            1e-309,
        ] {
            assert!(Kelvin::new(value).is_err(), "accepted {value}");
        }
        assert!(KelvinRange::new(0.0, 4000.0).is_err());
        assert!(KelvinRange::new(4000.0, 3000.0).is_err());

        let range = KelvinRange::new(2200.0, 6500.0).unwrap();
        assert_eq!(range.min().get(), 2200.0);
        assert_eq!(range.max().get(), 6500.0);
    }

    #[test]
    fn kelvin_range_clamps_values_and_signed_offsets() {
        let range = KelvinRange::new(2200.0, 6500.0).unwrap();

        assert_eq!(range.clamp(Kelvin::new(1800.0).unwrap()).get(), 2200.0);
        assert_eq!(range.clamp(Kelvin::new(7000.0).unwrap()).get(), 6500.0);
        assert_eq!(
            range
                .with_offset(Kelvin::new(3000.0).unwrap(), -1000.0)
                .unwrap()
                .get(),
            2200.0
        );
        assert_eq!(
            range
                .with_offset(Kelvin::new(6000.0).unwrap(), 1000.0)
                .unwrap()
                .get(),
            6500.0
        );
    }

    #[test]
    fn kelvin_offset_rejects_non_finite_inputs_and_results() {
        let range = KelvinRange::new(2200.0, 6500.0).unwrap();
        let kelvin = Kelvin::new(3000.0).unwrap();

        for offset in [f64::NAN, f64::NEG_INFINITY, f64::INFINITY] {
            assert!(
                range.with_offset(kelvin, offset).is_err(),
                "accepted {offset}"
            );
        }

        let huge_range = KelvinRange::new(1.0, f64::MAX).unwrap();
        assert!(
            huge_range
                .with_offset(Kelvin::new(f64::MAX).unwrap(), f64::MAX)
                .is_err()
        );
    }

    #[test]
    fn color_validates_xy_and_hue_saturation_ranges() {
        assert_eq!(
            Color::xy(0.25, 0.75).unwrap().xy_components(),
            Some((0.25, 0.75))
        );
        assert_eq!(
            Color::hs(240.0, 0.8).unwrap().hs_components(),
            Some((240.0, 0.8))
        );

        for (x, y) in [(-0.1, 0.5), (0.5, 1.1), (f64::NAN, 0.5)] {
            assert!(Color::xy(x, y).is_err(), "accepted ({x}, {y})");
        }
        for (hue, saturation) in [(-0.1, 0.5), (360.1, 0.5), (180.0, 1.1), (f64::NAN, 0.5)] {
            assert!(
                Color::hs(hue, saturation).is_err(),
                "accepted ({hue}, {saturation})"
            );
        }
    }

    #[test]
    fn serde_round_trips_validated_values_ranges_and_colors() {
        assert_json_round_trip(Brightness::new(0.4).unwrap());
        assert_json_round_trip(Kelvin::new(3200.0).unwrap());
        assert_json_round_trip(KelvinRange::new(2200.0, 6500.0).unwrap());
        assert_json_round_trip(Color::xy(0.25, 0.75).unwrap());
        assert_json_round_trip(Color::hs(240.0, 0.8).unwrap());
    }

    #[test]
    fn serde_rejects_values_that_violate_domain_invariants() {
        assert!(serde_json::from_str::<Brightness>("1.1").is_err());
        assert!(serde_json::from_str::<Kelvin>("0.0").is_err());
        assert!(serde_json::from_str::<KelvinRange>(r#"{"min":6500.0,"max":2200.0}"#).is_err());
        assert!(serde_json::from_str::<Color>(r#"{"xy":{"x":1.1,"y":0.5}}"#).is_err());
        assert!(serde_json::from_str::<Color>(r#"{"hs":{"hue":361.0,"saturation":0.5}}"#).is_err());

        let non_finite = F64Deserializer::<serde::de::value::Error>::new(f64::NAN);
        assert!(Brightness::deserialize(non_finite).is_err());
        let non_finite = F64Deserializer::<serde::de::value::Error>::new(f64::INFINITY);
        assert!(Kelvin::deserialize(non_finite).is_err());
    }

    #[test]
    fn degradation_omits_unsupported_fields_and_unused_transition() {
        let target = LightTarget {
            on: true,
            brightness: Some(Brightness::new(0.6).unwrap()),
            color_temperature: Some(Kelvin::new(4000.0).unwrap()),
            color: Some(Color::xy(0.25, 0.5).unwrap()),
            transition_ms: Some(750),
        };
        let capabilities = Capabilities {
            on_off: false,
            dimming: false,
            color_temperature: None,
            color_xy: false,
            color_hs: false,
            input: true,
            occupancy: true,
            temperature: true,
            power_metering: true,
        };

        assert_eq!(
            capabilities.degrade(&target),
            DeviceTarget {
                on: None,
                brightness: None,
                color_temperature: None,
                color: None,
                transition_ms: None,
            }
        );
    }

    #[test]
    fn degradation_keeps_transition_when_a_transitionable_field_survives() {
        let target = LightTarget {
            on: true,
            brightness: None,
            color_temperature: None,
            color: Some(Color::xy(0.25, 0.5).unwrap()),
            transition_ms: Some(750),
        };
        let capabilities = Capabilities {
            on_off: true,
            dimming: false,
            color_temperature: None,
            color_xy: true,
            color_hs: false,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        };

        assert_eq!(
            capabilities.degrade(&target),
            DeviceTarget {
                on: Some(true),
                brightness: None,
                color_temperature: None,
                color: target.color,
                transition_ms: Some(750),
            }
        );
    }

    #[test]
    fn degradation_prefers_supported_explicit_color_over_color_temperature() {
        let capabilities = Capabilities {
            on_off: true,
            dimming: true,
            color_temperature: Some(KelvinRange::new(2700.0, 5000.0).unwrap()),
            color_xy: false,
            color_hs: true,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        };
        let target = LightTarget {
            on: false,
            brightness: Some(Brightness::new(0.3).unwrap()),
            color_temperature: Some(Kelvin::new(6500.0).unwrap()),
            color: Some(Color::hs(30.0, 0.7).unwrap()),
            transition_ms: None,
        };

        let degraded = capabilities.degrade(&target);
        assert_eq!(degraded.on, Some(false));
        assert_eq!(degraded.brightness.unwrap().get(), 0.3);
        assert_eq!(degraded.color_temperature, None);
        assert_eq!(degraded.color.unwrap().hs_components(), Some((30.0, 0.7)));
    }

    #[test]
    fn degradation_falls_back_to_clamped_cct_when_explicit_color_is_unsupported() {
        let capabilities = Capabilities {
            on_off: true,
            dimming: false,
            color_temperature: Some(KelvinRange::new(2700.0, 5000.0).unwrap()),
            color_xy: false,
            color_hs: true,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        };
        let target = LightTarget {
            on: true,
            brightness: None,
            color_temperature: Some(Kelvin::new(6500.0).unwrap()),
            color: Some(Color::xy(0.2, 0.3).unwrap()),
            transition_ms: Some(500),
        };

        let degraded = capabilities.degrade(&target);
        assert_eq!(degraded.color, None);
        assert_eq!(degraded.color_temperature.unwrap().get(), 5000.0);
        assert_eq!(degraded.transition_ms, Some(500));
    }
}
