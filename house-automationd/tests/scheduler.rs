use chrono::{TimeZone, Utc};
use chrono_tz::Europe::Stockholm;
use house_automationd::scheduler::{Clock, Scheduler, TokioClock};

#[tokio::test(start_paused = true)]
async fn injected_clock_moves_wall_and_monotonic_together() {
    let start = Stockholm.with_ymd_and_hms(2026, 9, 13, 3, 59, 59).unwrap();
    let clock = TokioClock::at(start);
    let before = clock.sample();
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    let after = clock.sample();
    assert_eq!(after.wall.timestamp() - before.wall.timestamp(), 2);
    assert_eq!(
        after.runtime.monotonic,
        house_automation_core::state::MonotonicTime::from_seconds(2.0).unwrap()
    );
}

#[test]
fn forward_wall_jump_emits_at_most_latest_whole_hour_occurrence() {
    let mut scheduler = Scheduler::new(30.0).unwrap();
    let first = Stockholm.with_ymd_and_hms(2026, 9, 13, 12, 59, 58).unwrap();
    assert!(!scheduler.observe_wall(first).whole_hour);
    let jumped = Stockholm.with_ymd_and_hms(2026, 9, 13, 15, 0, 2).unwrap();
    let due = scheduler.observe_wall(jumped);
    assert!(due.whole_hour);
    assert_eq!(
        due.whole_hour_occurrence_unix_seconds,
        Some(
            Utc.with_ymd_and_hms(2026, 9, 13, 13, 0, 0)
                .unwrap()
                .timestamp()
        )
    );
    assert!(!scheduler.observe_wall(jumped).whole_hour);
}

#[test]
fn repeated_local_hour_has_distinct_occurrence_identity() {
    let mut scheduler = Scheduler::new(30.0).unwrap();
    let summer = Stockholm
        .with_ymd_and_hms(2026, 10, 25, 2, 0, 0)
        .earliest()
        .unwrap();
    let winter = Stockholm
        .with_ymd_and_hms(2026, 10, 25, 2, 0, 0)
        .latest()
        .unwrap();
    assert!(scheduler.observe_wall(summer).whole_hour);
    assert!(scheduler.observe_wall(winter).whole_hour);
}
