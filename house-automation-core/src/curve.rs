use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};

use crate::value::{Brightness, Kelvin, KelvinRange, ValueError};

const SECONDS_PER_DAY: u32 = 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u32", into = "u32")]
pub struct TimeOfDay(u32);

impl TimeOfDay {
    pub fn from_seconds(seconds: u32) -> Result<Self, CurveError> {
        if seconds >= SECONDS_PER_DAY {
            return Err(CurveError::InvalidTime);
        }

        Ok(Self(seconds))
    }

    pub fn from_hms(hour: u8, minute: u8, second: u8) -> Result<Self, CurveError> {
        if hour >= 24 || minute >= 60 || second >= 60 {
            return Err(CurveError::InvalidTime);
        }

        Self::from_seconds(u32::from(hour) * 3_600 + u32::from(minute) * 60 + u32::from(second))
    }

    pub fn seconds(self) -> u32 {
        self.0
    }
}

impl TryFrom<u32> for TimeOfDay {
    type Error = CurveError;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        Self::from_seconds(value)
    }
}

impl From<TimeOfDay> for u32 {
    fn from(value: TimeOfDay) -> Self {
        value.seconds()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CurveAnchor {
    time: TimeOfDay,
    brightness: Brightness,
    color_temperature: Kelvin,
}

impl CurveAnchor {
    pub fn new(
        time: TimeOfDay,
        brightness: Brightness,
        color_temperature_kelvin: f64,
    ) -> Result<Self, CurveError> {
        Ok(Self {
            time,
            brightness,
            color_temperature: Kelvin::new(color_temperature_kelvin)
                .map_err(CurveError::InvalidValue)?,
        })
    }

    pub fn time(self) -> TimeOfDay {
        self.time
    }

    pub fn brightness(self) -> Brightness {
        self.brightness
    }

    pub fn color_temperature(self) -> Kelvin {
        self.color_temperature
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurvePoint {
    brightness: Brightness,
    color_temperature: Kelvin,
}

impl CurvePoint {
    pub fn brightness(self) -> Brightness {
        self.brightness
    }

    pub fn color_temperature(self) -> Kelvin {
        self.color_temperature
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CircadianCurve {
    anchors: Vec<CurveAnchor>,
    brightness_slopes: Vec<f64>,
    color_temperature_slopes: Vec<f64>,
}

impl CircadianCurve {
    pub fn new(mut anchors: Vec<CurveAnchor>) -> Result<Self, CurveError> {
        if anchors.len() < 2 {
            return Err(CurveError::TooFewAnchors);
        }

        anchors.sort_by_key(|anchor| anchor.time);
        for pair in anchors.windows(2) {
            if pair[0].time == pair[1].time {
                return Err(CurveError::DuplicateAnchorTime(pair[0].time));
            }
        }

        let brightness_values: Vec<_> = anchors
            .iter()
            .map(|anchor| anchor.brightness.get())
            .collect();
        let color_temperature_values: Vec<_> = anchors
            .iter()
            .map(|anchor| anchor.color_temperature.get())
            .collect();

        Ok(Self {
            brightness_slopes: cyclic_monotone_slopes(&anchors, &brightness_values),
            color_temperature_slopes: cyclic_monotone_slopes(&anchors, &color_temperature_values),
            anchors,
        })
    }

    pub fn anchors(&self) -> &[CurveAnchor] {
        &self.anchors
    }

    pub fn sample(&self, time: TimeOfDay, kelvin_range: KelvinRange) -> CurvePoint {
        let brightness_values: Vec<_> = self
            .anchors
            .iter()
            .map(|anchor| anchor.brightness.get())
            .collect();
        let color_temperature_values: Vec<_> = self
            .anchors
            .iter()
            .map(|anchor| anchor.color_temperature.get())
            .collect();

        let brightness = interpolate(
            &self.anchors,
            &brightness_values,
            &self.brightness_slopes,
            time,
        );
        let color_temperature = interpolate(
            &self.anchors,
            &color_temperature_values,
            &self.color_temperature_slopes,
            time,
        );

        CurvePoint {
            brightness: Brightness::clamped(brightness)
                .expect("curve interpolation preserves finite brightness"),
            color_temperature: kelvin_range.clamp(
                Kelvin::new(color_temperature)
                    .expect("curve interpolation preserves positive finite Kelvin"),
            ),
        }
    }

    #[cfg(test)]
    fn neighbor_values(&self, time: TimeOfDay) -> (CurveAnchor, CurveAnchor) {
        match self
            .anchors
            .binary_search_by_key(&time, |anchor| anchor.time)
        {
            Ok(index) => (self.anchors[index], self.anchors[index]),
            Err(0) => (
                *self.anchors.last().expect("curve has at least two anchors"),
                self.anchors[0],
            ),
            Err(index) if index == self.anchors.len() => (self.anchors[index - 1], self.anchors[0]),
            Err(index) => (self.anchors[index - 1], self.anchors[index]),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CurveError {
    InvalidTime,
    TooFewAnchors,
    DuplicateAnchorTime(TimeOfDay),
    InvalidValue(ValueError),
}

impl fmt::Display for CurveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTime => formatter.write_str("time must fall within one local day"),
            Self::TooFewAnchors => {
                formatter.write_str("circadian curve needs at least two anchors")
            }
            Self::DuplicateAnchorTime(time) => {
                write!(
                    formatter,
                    "duplicate curve anchor at {} seconds",
                    time.seconds()
                )
            }
            Self::InvalidValue(error) => write!(formatter, "invalid curve value: {error}"),
        }
    }
}

impl Error for CurveError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidValue(error) => Some(error),
            _ => None,
        }
    }
}

fn cyclic_monotone_slopes(anchors: &[CurveAnchor], values: &[f64]) -> Vec<f64> {
    if anchors.len() == 2 {
        return vec![0.0; 2];
    }

    let count = anchors.len();
    let mut widths = Vec::with_capacity(count);
    let mut secants = Vec::with_capacity(count);
    for index in 0..count {
        let next = (index + 1) % count;
        let width = cyclic_width(anchors[index].time, anchors[next].time);
        widths.push(width);
        secants.push((values[next] - values[index]) / width);
    }

    (0..count)
        .map(|index| {
            let previous = (index + count - 1) % count;
            monotone_slope(
                widths[previous],
                widths[index],
                secants[previous],
                secants[index],
            )
        })
        .collect()
}

fn monotone_slope(previous_width: f64, next_width: f64, previous: f64, next: f64) -> f64 {
    if previous == 0.0 || next == 0.0 || previous.signum() != next.signum() {
        return 0.0;
    }

    let previous_weight = 2.0 * next_width + previous_width;
    let next_weight = next_width + 2.0 * previous_width;
    (previous_weight + next_weight) / (previous_weight / previous + next_weight / next)
}

fn interpolate(anchors: &[CurveAnchor], values: &[f64], slopes: &[f64], time: TimeOfDay) -> f64 {
    let (left, right, sample_seconds) = segment(anchors, time);
    if left == right {
        return values[left];
    }

    let left_seconds = f64::from(anchors[left].time.seconds());
    let right_seconds = if right == 0 {
        f64::from(anchors[right].time.seconds() + SECONDS_PER_DAY)
    } else {
        f64::from(anchors[right].time.seconds())
    };
    let sample_seconds = if sample_seconds < left_seconds {
        sample_seconds + f64::from(SECONDS_PER_DAY)
    } else {
        sample_seconds
    };
    let width = right_seconds - left_seconds;
    let position = (sample_seconds - left_seconds) / width;

    let interpolated = if anchors.len() == 2 {
        values[left] + position * (values[right] - values[left])
    } else {
        let position_squared = position * position;
        let position_cubed = position_squared * position;
        let left_basis = 2.0 * position_cubed - 3.0 * position_squared + 1.0;
        let left_slope_basis = position_cubed - 2.0 * position_squared + position;
        let right_basis = -2.0 * position_cubed + 3.0 * position_squared;
        let right_slope_basis = position_cubed - position_squared;
        left_basis * values[left]
            + left_slope_basis * width * slopes[left]
            + right_basis * values[right]
            + right_slope_basis * width * slopes[right]
    };

    interpolated.clamp(
        values[left].min(values[right]),
        values[left].max(values[right]),
    )
}

fn segment(anchors: &[CurveAnchor], time: TimeOfDay) -> (usize, usize, f64) {
    match anchors.binary_search_by_key(&time, |anchor| anchor.time) {
        Ok(index) => (index, index, f64::from(time.seconds())),
        Err(0) => (anchors.len() - 1, 0, f64::from(time.seconds())),
        Err(index) if index == anchors.len() => (index - 1, 0, f64::from(time.seconds())),
        Err(index) => (index - 1, index, f64::from(time.seconds())),
    }
}

fn cyclic_width(left: TimeOfDay, right: TimeOfDay) -> f64 {
    if right > left {
        f64::from(right.seconds() - left.seconds())
    } else {
        f64::from(SECONDS_PER_DAY - left.seconds() + right.seconds())
    }
}

#[cfg(test)]
mod tests {
    use crate::value::{Brightness, KelvinRange};

    use super::{CircadianCurve, CurveAnchor, CurveError, TimeOfDay};

    fn time(hour: u8, minute: u8) -> TimeOfDay {
        TimeOfDay::from_hms(hour, minute, 0).unwrap()
    }

    fn anchor(hour: u8, brightness: f64, kelvin: f64) -> CurveAnchor {
        CurveAnchor::new(time(hour, 0), Brightness::new(brightness).unwrap(), kelvin).unwrap()
    }

    fn default_range() -> KelvinRange {
        KelvinRange::new(2_200.0, 6_500.0).unwrap()
    }

    #[test]
    fn time_of_day_rejects_values_outside_one_day() {
        assert_eq!(TimeOfDay::from_seconds(86_399).unwrap().seconds(), 86_399);
        assert_eq!(
            TimeOfDay::from_seconds(86_400),
            Err(CurveError::InvalidTime)
        );
        assert_eq!(TimeOfDay::from_hms(24, 0, 0), Err(CurveError::InvalidTime));
        assert_eq!(TimeOfDay::from_hms(23, 60, 0), Err(CurveError::InvalidTime));
        assert_eq!(
            TimeOfDay::from_hms(23, 59, 60),
            Err(CurveError::InvalidTime)
        );
    }

    #[test]
    fn exact_anchor_times_return_exact_values() {
        let curve = CircadianCurve::new(vec![
            anchor(6, 0.2, 2_700.0),
            anchor(12, 0.9, 5_500.0),
            anchor(20, 0.3, 3_000.0),
        ])
        .unwrap();

        for expected in curve.anchors() {
            let actual = curve.sample(expected.time(), default_range());
            assert_eq!(actual.brightness(), expected.brightness());
            assert_eq!(actual.color_temperature(), expected.color_temperature());
        }
    }

    #[test]
    fn two_anchors_use_linear_interpolation_in_each_cyclic_segment() {
        let curve =
            CircadianCurve::new(vec![anchor(6, 0.2, 2_700.0), anchor(18, 0.8, 5_100.0)]).unwrap();

        let noon = curve.sample(time(12, 0), default_range());
        let midnight = curve.sample(time(0, 0), default_range());
        assert!((noon.brightness().get() - 0.5).abs() < 1e-12);
        assert!((noon.color_temperature().get() - 3_900.0).abs() < 1e-9);
        assert!((midnight.brightness().get() - 0.5).abs() < 1e-12);
        assert!((midnight.color_temperature().get() - 3_900.0).abs() < 1e-9);
    }

    #[test]
    fn midnight_wrap_interpolates_between_last_and_first_anchor() {
        let curve = CircadianCurve::new(vec![
            anchor(4, 0.2, 2_500.0),
            anchor(10, 0.7, 4_500.0),
            anchor(20, 0.4, 3_100.0),
        ])
        .unwrap();

        let at_midnight = curve.sample(time(0, 0), default_range());
        assert!((0.2..=0.4).contains(&at_midnight.brightness().get()));
        assert!((2_500.0..=3_100.0).contains(&at_midnight.color_temperature().get()));
    }

    #[test]
    fn monotone_segments_do_not_overshoot_neighboring_anchors() {
        let curve = CircadianCurve::new(vec![
            anchor(0, 0.1, 2_300.0),
            anchor(5, 0.2, 2_500.0),
            anchor(9, 0.8, 5_500.0),
            anchor(17, 0.9, 6_000.0),
            anchor(22, 0.3, 3_000.0),
        ])
        .unwrap();

        for second in (0..86_400).step_by(137) {
            let time = TimeOfDay::from_seconds(second).unwrap();
            let point = curve.sample(time, default_range());
            let (lower, upper) = curve.neighbor_values(time);
            let brightness = point.brightness().get();
            let kelvin = point.color_temperature().get();
            assert!(
                (lower.brightness().get().min(upper.brightness().get())
                    ..=lower.brightness().get().max(upper.brightness().get()))
                    .contains(&brightness),
                "brightness overshot at {second}: {brightness}"
            );
            assert!(
                (lower
                    .color_temperature()
                    .get()
                    .min(upper.color_temperature().get())
                    ..=lower
                        .color_temperature()
                        .get()
                        .max(upper.color_temperature().get()))
                    .contains(&kelvin),
                "CCT overshot at {second}: {kelvin}"
            );
        }
    }

    #[test]
    fn sampled_values_are_clamped_to_domain_and_requested_kelvin_range() {
        let curve = CircadianCurve::new(vec![
            anchor(0, 0.0, 2_000.0),
            anchor(6, 1.0, 7_000.0),
            anchor(12, 0.0, 2_000.0),
            anchor(18, 1.0, 7_000.0),
        ])
        .unwrap();
        let range = KelvinRange::new(2_700.0, 4_000.0).unwrap();

        for second in (0..86_400).step_by(97) {
            let point = curve.sample(TimeOfDay::from_seconds(second).unwrap(), range);
            assert!((0.0..=1.0).contains(&point.brightness().get()));
            assert!((2_700.0..=4_000.0).contains(&point.color_temperature().get()));
        }
    }

    #[test]
    fn constructor_sorts_anchors_and_rejects_malformed_sets() {
        assert_eq!(
            CircadianCurve::new(vec![anchor(6, 0.2, 2_700.0)]),
            Err(CurveError::TooFewAnchors)
        );
        assert_eq!(
            CircadianCurve::new(vec![anchor(6, 0.2, 2_700.0), anchor(6, 0.8, 5_000.0)]),
            Err(CurveError::DuplicateAnchorTime(time(6, 0)))
        );

        let curve =
            CircadianCurve::new(vec![anchor(18, 0.8, 5_100.0), anchor(6, 0.2, 2_700.0)]).unwrap();
        assert_eq!(curve.anchors()[0].time(), time(6, 0));
        assert_eq!(curve.anchors()[1].time(), time(18, 0));
    }

    #[test]
    fn anchor_rejects_invalid_kelvin() {
        assert!(CurveAnchor::new(time(6, 0), Brightness::new(0.5).unwrap(), f64::NAN).is_err());
        assert!(CurveAnchor::new(time(6, 0), Brightness::new(0.5).unwrap(), 0.0).is_err());
    }
}
