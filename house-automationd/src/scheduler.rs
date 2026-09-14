use std::{error::Error, fmt, time::Duration};

use chrono::{DateTime, Datelike, Timelike, Utc};
use chrono_tz::{Europe::Stockholm, Tz};
use house_automation_core::curve::TimeOfDay;
use house_automation_core::state::{LocalDate, MonotonicTime};

use crate::runtime::RuntimeInstant;

#[derive(Debug, Clone)]
pub struct ClockSample {
    pub wall: DateTime<Tz>,
    pub runtime: RuntimeInstant,
    pub unix_seconds: i64,
}

pub trait Clock: Send + Sync + 'static {
    fn sample(&self) -> ClockSample;
}

#[derive(Debug, Clone)]
pub struct TokioClock {
    wall_source: WallSource,
    monotonic_origin: tokio::time::Instant,
}

#[derive(Debug, Clone)]
enum WallSource {
    Derived(DateTime<Tz>),
    SystemStockholm,
}

impl TokioClock {
    pub fn at(wall_origin: DateTime<Tz>) -> Self {
        Self {
            wall_source: WallSource::Derived(wall_origin),
            monotonic_origin: tokio::time::Instant::now(),
        }
    }

    pub fn stockholm_now() -> Self {
        Self {
            wall_source: WallSource::SystemStockholm,
            monotonic_origin: tokio::time::Instant::now(),
        }
    }
}

impl Clock for TokioClock {
    fn sample(&self) -> ClockSample {
        let elapsed = tokio::time::Instant::now().duration_since(self.monotonic_origin);
        let wall = match &self.wall_source {
            WallSource::Derived(origin) => {
                *origin
                    + chrono::Duration::from_std(elapsed)
                        .expect("Tokio duration fits chrono duration")
            }
            WallSource::SystemStockholm => Utc::now().with_timezone(&Stockholm),
        };
        let runtime = RuntimeInstant::new(
            LocalDate::new(wall.year(), wall.month() as u8, wall.day() as u8)
                .expect("chrono date is a valid local date"),
            wall.hour() as u8,
            wall.minute() as u8,
            wall.second() as u8,
            MonotonicTime::from_seconds(elapsed.as_secs_f64())
                .expect("Tokio elapsed time is finite and nonnegative"),
        )
        .expect("chrono time is a valid time of day");
        ClockSample {
            unix_seconds: wall.timestamp(),
            wall,
            runtime,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SchedulerDue {
    pub curve_tick: bool,
    pub whole_hour: bool,
    pub whole_hour_occurrence_unix_seconds: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Scheduler {
    tick_seconds: f64,
    next_tick: Option<f64>,
    previous_wall_unix_seconds: Option<i64>,
    last_whole_hour_occurrence: Option<i64>,
}

impl Scheduler {
    pub fn new(tick_seconds: f64) -> Result<Self, SchedulerError> {
        if !tick_seconds.is_finite() || tick_seconds <= 0.0 {
            return Err(SchedulerError);
        }
        Ok(Self {
            tick_seconds,
            next_tick: None,
            previous_wall_unix_seconds: None,
            last_whole_hour_occurrence: None,
        })
    }

    pub fn observe(&mut self, sample: &ClockSample) -> SchedulerDue {
        let mut due = self.observe_wall(sample.wall);
        let now = sample.runtime.monotonic;
        let seconds = monotonic_seconds(now);
        match self.next_tick {
            None => {
                due.curve_tick = true;
                self.next_tick = Some(seconds + self.tick_seconds);
            }
            Some(deadline) if seconds >= deadline => {
                due.curve_tick = true;
                self.next_tick = Some(seconds + self.tick_seconds);
            }
            Some(_) => {}
        }
        due
    }

    pub fn observe_wall(&mut self, now: DateTime<Tz>) -> SchedulerDue {
        let now_unix = now.timestamp();
        // Subtract within this concrete UTC-offset occurrence. Reconstructing
        // `02:00` through local-time APIs is ambiguous on the DST fall-back.
        let boundary = now_unix - i64::from(now.minute() * 60 + now.second());
        let crossed = match self.previous_wall_unix_seconds {
            None => now.minute() == 0 && now.second() == 0,
            Some(previous) => now_unix >= previous && boundary > previous && boundary <= now_unix,
        };
        self.previous_wall_unix_seconds = Some(now_unix);
        let occurrence = crossed
            .then_some(boundary)
            .filter(|boundary| Some(*boundary) != self.last_whole_hour_occurrence);
        if let Some(occurrence) = occurrence {
            self.last_whole_hour_occurrence = Some(occurrence);
        }
        SchedulerDue {
            curve_tick: false,
            whole_hour: occurrence.is_some(),
            whole_hour_occurrence_unix_seconds: occurrence,
        }
    }

    pub fn next_tick_delay(&self, now: MonotonicTime) -> Duration {
        let seconds = monotonic_seconds(now);
        let delay = self
            .next_tick
            .map(|deadline| (deadline - seconds).max(0.001))
            .unwrap_or(0.001);
        Duration::from_secs_f64(delay)
    }

    pub fn next_wall_event_delay(&self, sample: &ClockSample, reset_time: TimeOfDay) -> Duration {
        let current = sample.runtime.local_time.seconds();
        let next_hour = 3_600 - (current % 3_600);
        let reset = reset_time.seconds();
        let until_reset = if reset > current {
            reset - current
        } else {
            86_400 - current + reset
        };
        Duration::from_secs(u64::from(next_hour.min(until_reset).max(1)))
    }
}

fn monotonic_seconds(value: MonotonicTime) -> f64 {
    // Core deliberately keeps its scalar private. Ordering plus a zero-origin
    // duration is enough here; serialize through Debug would be brittle, so
    // expose the scalar via a small core accessor instead.
    value.as_seconds()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedulerError;

impl fmt::Display for SchedulerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("scheduler interval must be finite and positive")
    }
}

impl Error for SchedulerError {}
