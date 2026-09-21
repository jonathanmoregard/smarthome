use std::{error::Error, f64::consts::PI, fmt};

use chrono::{Datelike, NaiveDate, Offset, TimeZone};
use chrono_tz::Tz;
use house_automation_core::state::LocalDate;

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
}

impl fmt::Display for SolarError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCoordinates => "coordinates must be finite latitude/longitude values",
            Self::InvalidMonthDay => "month-day must be a valid MM-DD value",
            Self::ReferenceOutsideHold => "winter reference must fall inside hold interval",
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
    let noon_minutes = normalize_minutes(noon);
    if !(-1.0..=1.0).contains(&hour_angle_cosine) {
        return SolarEvents {
            sunrise_minutes: None,
            noon_minutes,
            sunset_minutes: None,
        };
    }

    let hour_angle_minutes = hour_angle_cosine.acos().to_degrees() * 4.0;
    SolarEvents {
        sunrise_minutes: Some(normalize_minutes(noon - hour_angle_minutes)),
        noon_minutes,
        sunset_minutes: Some(normalize_minutes(noon + hour_angle_minutes)),
    }
}

fn normalize_minutes(minutes: f64) -> i32 {
    (minutes.round() as i32).rem_euclid(24 * 60)
}

#[cfg(test)]
mod tests {
    use chrono_tz::Europe::Stockholm;
    use house_automation_core::state::LocalDate;

    use super::{Coordinates, MonthDay, WinterHold, solar_events};

    fn date(year: i32, month: u8, day: u8) -> LocalDate {
        LocalDate::new(year, month, day).unwrap()
    }

    fn stockholm() -> Coordinates {
        Coordinates::new(59.3, 18.1).unwrap()
    }

    fn month_day(month: u8, day: u8) -> MonthDay {
        MonthDay::new(month, day).unwrap()
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
}
