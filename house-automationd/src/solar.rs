use std::{error::Error, f64::consts::PI, fmt};

use chrono::{Datelike, NaiveDate, Offset, TimeZone};
use chrono_tz::Tz;
use house_automation_core::{
    curve::{CircadianCurve, CurveAnchor, CurvePoint, TimeOfDay},
    state::LocalDate,
    value::{Brightness, Kelvin},
};

const MINIMUM_AWAKE_SECONDS: u32 = 8 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Coordinates {
    latitude: f64,
    longitude: f64,
}

impl Coordinates {
    pub fn new(latitude: f64, longitude: f64) -> Result<Self, SolarError> {
        if !latitude.is_finite()
            || !longitude.is_finite()
            || !(-90.0..=90.0).contains(&latitude)
            || !(-180.0..=180.0).contains(&longitude)
        {
            return Err(SolarError::InvalidCoordinates);
        }
        Ok(Self {
            latitude,
            longitude,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct MonthDay {
    month: u8,
    day: u8,
}

impl MonthDay {
    pub fn new(month: u8, day: u8) -> Result<Self, SolarError> {
        LocalDate::new(2000, month, day).map_err(|_| SolarError::InvalidMonthDay)?;
        Ok(Self { month, day })
    }

    fn from_date(date: LocalDate) -> Self {
        Self {
            month: date.month(),
            day: date.day(),
        }
    }

    fn in_year(self, year: i32) -> Option<LocalDate> {
        LocalDate::new(year, self.month, self.day)
            .or_else(|_| LocalDate::new(year, self.month, self.day.saturating_sub(1)))
            .ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WinterHold {
    start: MonthDay,
    end: MonthDay,
    reference: MonthDay,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CircadianSchedule {
    Fixed(CircadianCurve),
    SolarHybrid(SolarHybridCurve),
}

impl CircadianSchedule {
    pub fn sample(&self, date: LocalDate, time: TimeOfDay) -> CurvePoint {
        match self {
            Self::Fixed(curve) => curve.sample(time),
            Self::SolarHybrid(curve) => curve.generated_curve(date).sample(time),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
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

impl SolarHybridCurve {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        coordinates: Coordinates,
        time_zone: Tz,
        wake_time: TimeOfDay,
        bed_time: TimeOfDay,
        night_brightness: Brightness,
        day_brightness: Brightness,
        night_kelvin: Kelvin,
        day_kelvin: Kelvin,
        winter_hold: Option<WinterHold>,
    ) -> Result<Self, SolarError> {
        let awake_seconds = bed_time
            .seconds()
            .checked_sub(wake_time.seconds())
            .filter(|seconds| *seconds >= MINIMUM_AWAKE_SECONDS)
            .ok_or(SolarError::InvalidSchedule)?;
        debug_assert!(awake_seconds < 24 * 60 * 60);
        if night_brightness.get() >= day_brightness.get() || night_kelvin.get() >= day_kelvin.get()
        {
            return Err(SolarError::InvalidSchedule);
        }
        Ok(Self {
            coordinates,
            time_zone,
            wake_time,
            bed_time,
            night_brightness,
            day_brightness,
            night_kelvin,
            day_kelvin,
            winter_hold,
        })
    }

    fn generated_curve(&self, date: LocalDate) -> CircadianCurve {
        let effective_date = self
            .winter_hold
            .map_or(date, |hold| hold.effective_date(date));
        let events = solar_events(effective_date, self.coordinates, self.time_zone);
        let wake = minutes(self.wake_time);
        let bed = minutes(self.bed_time);
        let noon = events.noon_minutes.clamp(wake + 180, bed - 240);
        let morning_ready = events
            .sunrise_minutes
            .map_or(wake + 90, |sunrise| (sunrise + 45).max(wake + 90))
            .clamp(wake + 60, noon - 60);
        let color_evening = events
            .sunset_minutes
            .map_or(bed - 180, |sunset| sunset + 45)
            .clamp(noon + 60, bed - 150);
        let brightness_evening = events
            .sunset_minutes
            .map_or(bed - 90, |sunset| sunset + 120)
            .clamp(color_evening + 60, bed - 90);

        let anchors = [
            self.anchor(wake, 0.0, 0.0),
            self.anchor(morning_ready, 0.72, 0.65),
            self.anchor(noon, 1.0, 1.0),
            self.anchor(color_evening, 1.0, 0.55),
            self.anchor(brightness_evening, 0.60, 0.25),
            self.anchor(bed, 0.0, 0.0),
        ];
        CircadianCurve::new(anchors.into_iter().collect())
            .expect("validated hybrid policy generates unique valid anchors")
    }

    fn anchor(&self, minutes: i32, brightness_factor: f64, color_factor: f64) -> CurveAnchor {
        let brightness = blend(
            self.night_brightness.get(),
            self.day_brightness.get(),
            brightness_factor,
        );
        CurveAnchor::new(
            TimeOfDay::from_seconds(
                u32::try_from(minutes).expect("generated minute is nonnegative") * 60,
            )
            .expect("generated minute falls inside local day"),
            Brightness::new(brightness).expect("brightness endpoints and factor are valid"),
            blend_kelvin(self.night_kelvin, self.day_kelvin, color_factor),
        )
        .expect("hybrid anchor values are valid")
    }
}

impl WinterHold {
    pub fn new(start: MonthDay, end: MonthDay, reference: MonthDay) -> Result<Self, SolarError> {
        let hold = Self {
            start,
            end,
            reference,
        };
        if !hold.contains(reference) {
            return Err(SolarError::ReferenceOutsideHold);
        }
        Ok(hold)
    }

    pub fn effective_date(self, date: LocalDate) -> LocalDate {
        let month_day = MonthDay::from_date(date);
        if !self.contains(month_day) {
            return date;
        }

        let crosses_year = self.start > self.end;
        let start_year = if crosses_year && month_day <= self.end {
            let Some(year) = date.year().checked_sub(1) else {
                return date;
            };
            year
        } else {
            date.year()
        };
        let reference_year = if crosses_year && self.reference <= self.end {
            let Some(year) = start_year.checked_add(1) else {
                return date;
            };
            year
        } else {
            start_year
        };
        self.reference.in_year(reference_year).unwrap_or(date)
    }

    fn contains(self, value: MonthDay) -> bool {
        if self.start <= self.end {
            (self.start..=self.end).contains(&value)
        } else {
            value >= self.start || value <= self.end
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolarError {
    InvalidCoordinates,
    InvalidMonthDay,
    ReferenceOutsideHold,
    InvalidSchedule,
}

impl fmt::Display for SolarError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCoordinates => "coordinates must be finite latitude/longitude values",
            Self::InvalidMonthDay => "month-day must be a valid MM-DD value",
            Self::ReferenceOutsideHold => "winter reference must fall inside hold interval",
            Self::InvalidSchedule => {
                "solar curve needs an eight-hour wake/bed window and increasing day bounds"
            }
        })
    }
}

impl Error for SolarError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SolarEvents {
    sunrise_minutes: Option<i32>,
    noon_minutes: i32,
    sunset_minutes: Option<i32>,
}

fn solar_events(date: LocalDate, coordinates: Coordinates, time_zone: Tz) -> SolarEvents {
    let naive_date =
        NaiveDate::from_ymd_opt(date.year(), u32::from(date.month()), u32::from(date.day()))
            .expect("runtime local date is representable by chrono");
    let local_noon = naive_date
        .and_hms_opt(12, 0, 0)
        .expect("noon is a valid local time");
    let offset_seconds = time_zone
        .offset_from_local_datetime(&local_noon)
        .single()
        .expect("local noon has one timezone offset")
        .fix()
        .local_minus_utc();

    let fractional_year = 2.0 * PI / 365.0 * (f64::from(naive_date.ordinal()) - 1.0);
    let equation_of_time = 229.18
        * (0.000_075 + 0.001_868 * fractional_year.cos()
            - 0.032_077 * fractional_year.sin()
            - 0.014_615 * (2.0 * fractional_year).cos()
            - 0.040_849 * (2.0 * fractional_year).sin());
    let declination = 0.006_918 - 0.399_912 * fractional_year.cos()
        + 0.070_257 * fractional_year.sin()
        - 0.006_758 * (2.0 * fractional_year).cos()
        + 0.000_907 * (2.0 * fractional_year).sin()
        - 0.002_697 * (3.0 * fractional_year).cos()
        + 0.001_48 * (3.0 * fractional_year).sin();
    let noon =
        720.0 - 4.0 * coordinates.longitude - equation_of_time + f64::from(offset_seconds) / 60.0;
    let latitude = coordinates.latitude.to_radians();
    let hour_angle_cosine = 90.833_f64.to_radians().cos() / (latitude.cos() * declination.cos())
        - latitude.tan() * declination.tan();
    let normalized_noon = noon.rem_euclid(f64::from(24 * 60));
    let noon_minutes = normalize_minutes(normalized_noon);
    if !(-1.0..=1.0).contains(&hour_angle_cosine) {
        return SolarEvents {
            sunrise_minutes: None,
            noon_minutes,
            sunset_minutes: None,
        };
    }

    let hour_angle_minutes = hour_angle_cosine.acos().to_degrees() * 4.0;
    SolarEvents {
        sunrise_minutes: Some(round_minutes(normalized_noon - hour_angle_minutes)),
        noon_minutes,
        sunset_minutes: Some(round_minutes(normalized_noon + hour_angle_minutes)),
    }
}

fn normalize_minutes(minutes: f64) -> i32 {
    round_minutes(minutes).rem_euclid(24 * 60)
}

fn round_minutes(minutes: f64) -> i32 {
    minutes.round() as i32
}

fn minutes(time: TimeOfDay) -> i32 {
    i32::try_from(time.seconds() / 60).expect("time-of-day minutes fit i32")
}

fn blend(low: f64, high: f64, factor: f64) -> f64 {
    low + (high - low) * factor
}

fn blend_kelvin(night: Kelvin, day: Kelvin, factor: f64) -> f64 {
    let night_mired = 1_000_000.0 / night.get();
    let day_mired = 1_000_000.0 / day.get();
    1_000_000.0 / blend(night_mired, day_mired, factor)
}

#[cfg(test)]
mod tests {
    use chrono_tz::Europe::Stockholm;
    use house_automation_core::{
        curve::TimeOfDay,
        state::LocalDate,
        value::{Brightness, Kelvin},
    };

    use super::{
        CircadianSchedule, Coordinates, MonthDay, SolarHybridCurve, WinterHold, solar_events,
    };

    fn date(year: i32, month: u8, day: u8) -> LocalDate {
        LocalDate::new(year, month, day).unwrap()
    }

    fn stockholm() -> Coordinates {
        Coordinates::new(59.3, 18.1).unwrap()
    }

    fn month_day(month: u8, day: u8) -> MonthDay {
        MonthDay::new(month, day).unwrap()
    }

    fn time(hour: u8, minute: u8) -> TimeOfDay {
        TimeOfDay::from_hms(hour, minute, 0).unwrap()
    }

    fn hybrid_curve(winter_hold: Option<WinterHold>) -> SolarHybridCurve {
        SolarHybridCurve::new(
            stockholm(),
            Stockholm,
            time(7, 0),
            time(23, 0),
            Brightness::new(0.1).unwrap(),
            Brightness::new(1.0).unwrap(),
            Kelvin::new(2_200.0).unwrap(),
            Kelvin::new(5_000.0).unwrap(),
            winter_hold,
        )
        .unwrap()
    }

    #[test]
    fn stockholm_equinox_events_are_plausible() {
        let events = solar_events(date(2026, 3, 20), stockholm(), Stockholm);

        assert!((5 * 60..=7 * 60).contains(&events.sunrise_minutes.unwrap()));
        assert!((11 * 60..=13 * 60).contains(&events.noon_minutes));
        assert!((17 * 60..=19 * 60).contains(&events.sunset_minutes.unwrap()));
    }

    #[test]
    fn stockholm_solstice_events_reflect_nordic_seasons() {
        let summer = solar_events(date(2026, 6, 21), stockholm(), Stockholm);
        let winter = solar_events(date(2026, 12, 21), stockholm(), Stockholm);

        assert!((3 * 60..=5 * 60).contains(&summer.sunrise_minutes.unwrap()));
        assert!((21 * 60..=23 * 60).contains(&summer.sunset_minutes.unwrap()));
        assert!((8 * 60..=10 * 60).contains(&winter.sunrise_minutes.unwrap()));
        assert!((14 * 60..=16 * 60).contains(&winter.sunset_minutes.unwrap()));
    }

    #[test]
    fn cross_year_winter_hold_maps_to_prior_november() {
        let hold = WinterHold::new(month_day(11, 1), month_day(1, 31), month_day(11, 1)).unwrap();

        assert_eq!(hold.effective_date(date(2026, 11, 1)), date(2026, 11, 1));
        assert_eq!(hold.effective_date(date(2026, 12, 21)), date(2026, 11, 1));
        assert_eq!(hold.effective_date(date(2027, 1, 15)), date(2026, 11, 1));
        assert_eq!(hold.effective_date(date(2027, 2, 1)), date(2027, 2, 1));
    }

    #[test]
    fn winter_hold_rejects_reference_outside_interval() {
        assert!(WinterHold::new(month_day(11, 1), month_day(1, 31), month_day(2, 1),).is_err());
    }

    #[test]
    fn solar_inputs_reject_invalid_coordinates_and_calendar_days() {
        for (latitude, longitude) in [
            (f64::NAN, 18.1),
            (91.0, 18.1),
            (-91.0, 18.1),
            (59.3, 181.0),
            (59.3, -181.0),
        ] {
            assert!(Coordinates::new(latitude, longitude).is_err());
        }
        for (month, day) in [(0, 1), (13, 1), (2, 30), (4, 31), (11, 0)] {
            assert!(MonthDay::new(month, day).is_err());
        }
    }

    #[test]
    fn polar_events_remain_explicitly_absent() {
        let events = solar_events(
            date(2026, 6, 21),
            Coordinates::new(90.0, 0.0).unwrap(),
            chrono_tz::UTC,
        );

        assert_eq!(events.sunrise_minutes, None);
        assert_eq!(events.sunset_minutes, None);
        assert!((0..24 * 60).contains(&events.noon_minutes));
    }

    #[test]
    fn after_midnight_sunset_uses_late_evening_policy_bounds() {
        let schedule = SolarHybridCurve::new(
            Coordinates::new(65.0, 12.0).unwrap(),
            chrono_tz::Europe::Oslo,
            time(7, 0),
            time(23, 0),
            Brightness::new(0.1).unwrap(),
            Brightness::new(1.0).unwrap(),
            Kelvin::new(2_200.0).unwrap(),
            Kelvin::new(5_000.0).unwrap(),
            None,
        )
        .unwrap();

        let curve = schedule.generated_curve(date(2026, 6, 24));

        assert_eq!(curve.anchors()[3].time(), time(20, 30));
        assert_eq!(curve.anchors()[4].time(), time(21, 30));
    }

    #[test]
    fn winter_hold_keeps_november_curve_through_january() {
        let hold = WinterHold::new(month_day(11, 1), month_day(1, 31), month_day(11, 1)).unwrap();
        let schedule = hybrid_curve(Some(hold));

        let november = schedule.generated_curve(date(2026, 11, 1));
        let december = schedule.generated_curve(date(2026, 12, 21));
        let january = schedule.generated_curve(date(2027, 1, 15));
        let february = schedule.generated_curve(date(2027, 2, 1));

        assert_eq!(november.anchors(), december.anchors());
        assert_eq!(november.anchors(), january.anchors());
        assert_ne!(november.anchors(), february.anchors());
    }

    #[test]
    fn hybrid_curve_rises_and_falls_with_separate_color_transition() {
        let schedule = hybrid_curve(None);
        let curve = schedule.generated_curve(date(2026, 9, 21));
        let anchors = curve.anchors();

        assert_eq!(anchors.len(), 6);
        assert!(anchors[2].brightness().get() > anchors[1].brightness().get());
        assert!(anchors[2].brightness().get() > anchors[4].brightness().get());
        assert_eq!(anchors[3].brightness(), anchors[2].brightness());
        assert!(
            anchors[3].color_temperature().get() < anchors[2].color_temperature().get(),
            "color should begin warming before brightness falls"
        );
    }

    #[test]
    fn hybrid_samples_stay_inside_configured_output_bounds() {
        let schedule = CircadianSchedule::SolarHybrid(hybrid_curve(None));

        for minute in (0..24 * 60).step_by(5) {
            let point = schedule.sample(
                date(2026, 6, 21),
                TimeOfDay::from_seconds(minute * 60).unwrap(),
            );
            assert!((0.1..=1.0).contains(&point.brightness().get()));
            assert!((2_200.0..=5_000.0).contains(&point.color_temperature().get()));
        }
    }

    #[test]
    fn hybrid_curve_rejects_short_or_inverted_day_bounds() {
        let valid = hybrid_curve(None);
        assert!(
            SolarHybridCurve::new(
                stockholm(),
                Stockholm,
                time(7, 0),
                time(12, 0),
                Brightness::new(0.1).unwrap(),
                Brightness::new(1.0).unwrap(),
                Kelvin::new(2_200.0).unwrap(),
                Kelvin::new(5_000.0).unwrap(),
                None,
            )
            .is_err()
        );
        assert!(
            SolarHybridCurve::new(
                stockholm(),
                Stockholm,
                time(7, 0),
                time(23, 0),
                Brightness::new(1.0).unwrap(),
                Brightness::new(0.1).unwrap(),
                Kelvin::new(2_200.0).unwrap(),
                Kelvin::new(5_000.0).unwrap(),
                None,
            )
            .is_err()
        );
        assert!(
            SolarHybridCurve::new(
                stockholm(),
                Stockholm,
                time(7, 0),
                time(23, 0),
                Brightness::new(0.1).unwrap(),
                Brightness::new(1.0).unwrap(),
                Kelvin::new(5_000.0).unwrap(),
                Kelvin::new(2_200.0).unwrap(),
                None,
            )
            .is_err()
        );
        assert_eq!(valid.generated_curve(date(2026, 9, 21)).anchors().len(), 6);
    }
}
