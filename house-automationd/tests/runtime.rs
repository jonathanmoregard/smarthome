use std::{fs, sync::Arc};

use house_automation_core::{
    input::Gesture,
    reconcile::DeviceId,
    state::{
        AutomationState, ControlId, ControlState, CurveMode, LocalDate, MonotonicTime, Scope,
        ScopeId, ScopeState,
    },
};
use house_automationd::{
    config::ValidatedConfig,
    health::{HealthSnapshot, HealthState},
    mqtt::load_credentials,
    runtime::{HouseEngine, RuntimeInstant},
    zigbee2mqtt::PlanEpoch,
};
use tempfile::tempdir;

fn config() -> ValidatedConfig {
    ValidatedConfig::parse(include_str!("../../examples/house.toml")).unwrap()
}

fn instant(hour: u8, minute: u8, monotonic: f64) -> RuntimeInstant {
    dated_instant(13, hour, minute, monotonic)
}

fn dated_instant(day: u8, hour: u8, minute: u8, monotonic: f64) -> RuntimeInstant {
    RuntimeInstant::new(
        LocalDate::new(2026, 9, day).unwrap(),
        hour,
        minute,
        0,
        MonotonicTime::from_seconds(monotonic).unwrap(),
    )
    .unwrap()
}

fn instant_with_second(hour: u8, minute: u8, second: u8, monotonic: f64) -> RuntimeInstant {
    RuntimeInstant::new(
        LocalDate::new(2026, 9, 13).unwrap(),
        hour,
        minute,
        second,
        MonotonicTime::from_seconds(monotonic).unwrap(),
    )
    .unwrap()
}

#[test]
fn acknowledgement_expires_into_recomputed_current_target() {
    let mut engine = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        instant(12, 0, 0.0),
    )
    .unwrap();
    let device = DeviceId::new("reading-light").unwrap();
    engine
        .apply_gesture_for_scope(Gesture::CenterSingle, &Scope::House, instant(12, 0, 0.5))
        .unwrap();
    engine
        .apply_gesture_for_scope(Gesture::CenterDouble, &Scope::House, instant(12, 0, 1.0))
        .unwrap();
    let pulse = engine.target(&device).unwrap().brightness.unwrap().get();

    engine.recompute_desired(instant(12, 0, 1.181)).unwrap();
    let after = engine.target(&device).unwrap().brightness.unwrap().get();
    assert_ne!(pulse, after);
    assert!(matches!(
        engine
            .state()
            .scope_state(engine.owner_scope(&device).unwrap())
            .unwrap()
            .mode(),
        CurveMode::Frozen { .. }
    ));
}

#[test]
fn whole_hour_overlay_expires_without_restoring_stale_target() {
    let mut engine = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        instant(12, 0, 0.0),
    )
    .unwrap();
    let device = DeviceId::new("reading-light").unwrap();
    engine
        .apply_gesture_for_scope(Gesture::CenterSingle, &Scope::House, instant(12, 0, 0.1))
        .unwrap();
    engine
        .start_whole_hour_overlay(instant(12, 0, 1.0))
        .unwrap();
    let pulse = engine.target(&device).unwrap().brightness.unwrap().get();
    engine
        .apply_gesture_for_scope(Gesture::Down, &Scope::House, instant(12, 0, 1.2))
        .unwrap();
    engine.recompute_desired(instant(12, 0, 1.501)).unwrap();
    let after = engine.target(&device).unwrap().brightness.unwrap().get();
    assert!(after < pulse);
    assert_eq!(
        engine
            .state()
            .scope_state(engine.owner_scope(&device).unwrap())
            .unwrap()
            .offsets()
            .brightness(),
        -0.05
    );
}

#[test]
fn restart_after_missed_four_am_unfreezes_every_physical_owner_smoothly() {
    let mut first = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        dated_instant(13, 12, 0, 0.0),
    )
    .unwrap();
    first
        .apply_gesture_for_scope(
            Gesture::CenterDouble,
            &Scope::House,
            dated_instant(13, 12, 0, 1.0),
        )
        .unwrap();
    assert!(first.owner_states().all(|(_, state)| state.is_frozen()));

    let restored = HouseEngine::initialize(
        config().into_runtime_parts(),
        first.state().clone(),
        dated_instant(14, 5, 0, 0.0),
    )
    .unwrap();
    assert!(
        restored
            .owner_states()
            .all(|(_, state)| matches!(state.mode(), CurveMode::Converging { .. }))
    );
    assert_eq!(
        restored.state().last_reset_date(),
        Some(LocalDate::new(2026, 9, 14).unwrap())
    );
}

#[test]
fn optional_group_cct_keeps_group_power_brightness_and_member_cct_fallbacks() {
    let mut engine = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        instant(4, 0, 0.0),
    )
    .unwrap();
    engine.recompute_desired(instant(4, 0, 0.0)).unwrap();
    let actions = engine
        .reconciler_mut()
        .broker_connected(MonotonicTime::from_seconds(0.1).unwrap())
        .unwrap();
    let grouped = engine
        .adapter()
        .apply_actions(
            PlanEpoch::new(MonotonicTime::from_seconds(0.1).unwrap()),
            &actions,
        )
        .unwrap();
    assert!(
        grouped
            .operations()
            .iter()
            .filter_map(|operation| operation.publication())
            .any(|publication| publication.topic() == "zigbee2mqtt/demo/living-room/lights/set")
    );

    let (actions, _) = engine.recompute_desired(instant(12, 0, 1.0)).unwrap();
    assert!(!actions.is_empty());
    engine
        .reconciler_mut()
        .broker_disconnected(MonotonicTime::from_seconds(1.1).unwrap())
        .unwrap();
    let reconnect = engine
        .reconciler_mut()
        .broker_connected(MonotonicTime::from_seconds(1.2).unwrap())
        .unwrap();
    let noon = engine
        .adapter()
        .apply_actions(
            PlanEpoch::new(MonotonicTime::from_seconds(1.2).unwrap()),
            &reconnect,
        )
        .unwrap();
    let topics: Vec<_> = noon
        .operations()
        .iter()
        .filter_map(|operation| operation.publication())
        .filter(|publication| publication.topic().ends_with("/set"))
        .map(|publication| publication.topic())
        .collect();
    assert!(topics.contains(&"zigbee2mqtt/demo/living-room/lights/set"));
    assert!(topics.contains(&"zigbee2mqtt/demo/living-room/reading-light/set"));
    assert!(topics.contains(&"zigbee2mqtt/demo/living-room/color-light/set"));
}

#[test]
fn optional_group_cct_degrades_the_unclamped_owner_target_per_member() {
    let input = include_str!("../../examples/house.toml")
        .replace(
            "color_temperature_kelvin = 2200",
            "color_temperature_kelvin = 1800",
        )
        .replace(
            "color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 6500, minimum_mired = 153, maximum_mired = 454 }",
            "color_temperature = { minimum_kelvin = 2700, maximum_kelvin = 6500, minimum_mired = 153, maximum_mired = 370 }",
        )
        .replace(
            "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 4000 } }",
            "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2700, maximum_kelvin = 4000 } }",
        );
    let mut engine = HouseEngine::initialize(
        ValidatedConfig::parse(&input).unwrap().into_runtime_parts(),
        Default::default(),
        instant(4, 0, 0.0),
    )
    .unwrap();
    engine.recompute_desired(instant(4, 0, 0.0)).unwrap();
    let actions = engine
        .reconciler_mut()
        .broker_connected(MonotonicTime::from_seconds(0.1).unwrap())
        .unwrap();
    let plan = engine
        .adapter()
        .apply_actions(
            PlanEpoch::new(MonotonicTime::from_seconds(0.1).unwrap()),
            &actions,
        )
        .unwrap();
    let color_temperatures: std::collections::BTreeMap<_, _> = plan
        .operations()
        .iter()
        .filter_map(|operation| operation.publication())
        .filter_map(|publication| {
            let payload: serde_json::Value = serde_json::from_slice(publication.payload()).unwrap();
            payload
                .get("color_temp")
                .and_then(serde_json::Value::as_u64)
                .map(|value| (publication.topic(), value))
        })
        .collect();

    assert_eq!(
        color_temperatures["zigbee2mqtt/demo/living-room/reading-light/set"],
        454
    );
    assert_eq!(
        color_temperatures["zigbee2mqtt/demo/living-room/color-light/set"],
        370
    );
}

#[test]
fn cross_owner_native_group_is_never_used_and_stays_cleared_after_reconnect() {
    let input = include_str!("../../examples/house.toml").replace(
        "friendly_name = \"demo/living-room/color-light\"\nroom = \"living-room\"",
        "friendly_name = \"demo/living-room/color-light\"\nroom = \"second-room\"",
    ) + "\n[[rooms]]\nid = \"second-room\"\nfloor = \"ground-floor\"\n\n[[scopes]]\nid = \"second-room-lights\"\nkind = \"room\"\nroom = \"second-room\"\ncurve = \"default-day\"\n";
    let mut engine = HouseEngine::initialize(
        ValidatedConfig::parse(&input).unwrap().into_runtime_parts(),
        Default::default(),
        instant(4, 0, 0.0),
    )
    .unwrap();
    engine.recompute_desired(instant(4, 0, 0.0)).unwrap();
    let actions = engine
        .reconciler_mut()
        .broker_connected(MonotonicTime::from_seconds(0.1).unwrap())
        .unwrap();
    let plan = engine
        .adapter()
        .apply_actions(
            PlanEpoch::new(MonotonicTime::from_seconds(0.1).unwrap()),
            &actions,
        )
        .unwrap();
    let topics: Vec<_> = plan
        .operations()
        .iter()
        .filter_map(|operation| operation.publication())
        .filter(|publication| publication.topic().ends_with("/set"))
        .map(|publication| publication.topic())
        .collect();
    assert!(!topics.contains(&"zigbee2mqtt/demo/living-room/lights/set"));
    assert!(topics.contains(&"zigbee2mqtt/demo/living-room/reading-light/set"));
    assert!(topics.contains(&"zigbee2mqtt/demo/living-room/color-light/set"));

    engine
        .reconciler_mut()
        .broker_disconnected(MonotonicTime::from_seconds(0.2).unwrap())
        .unwrap();
    let reconnect = engine
        .reconciler_mut()
        .broker_connected(MonotonicTime::from_seconds(0.3).unwrap())
        .unwrap();
    let plan = engine
        .adapter()
        .apply_actions(
            PlanEpoch::new(MonotonicTime::from_seconds(0.3).unwrap()),
            &reconnect,
        )
        .unwrap();
    let reconnect_topics: Vec<_> = plan
        .operations()
        .iter()
        .filter_map(|operation| operation.publication())
        .filter(|publication| publication.topic().ends_with("/set"))
        .map(|publication| publication.topic())
        .collect();
    assert!(!reconnect_topics.contains(&"zigbee2mqtt/demo/living-room/lights/set"));
    assert!(reconnect_topics.contains(&"zigbee2mqtt/demo/living-room/reading-light/set"));
    assert!(reconnect_topics.contains(&"zigbee2mqtt/demo/living-room/color-light/set"));
}

#[test]
fn configuration_authoritatively_drops_stale_state_and_resets_invalid_control_selection() {
    let living = Scope::Room(ScopeId::new("living-room").unwrap());
    let stale = Scope::Room(ScopeId::new("removed-room").unwrap());
    let control = ControlId::new("living-room-remote").unwrap();
    let mut persisted = AutomationState::default();
    persisted
        .insert_scope(living.clone(), ScopeState::new(true))
        .unwrap();
    persisted
        .insert_scope(stale.clone(), ScopeState::new(true))
        .unwrap();
    persisted
        .insert_control(control.clone(), ControlState::new(stale.clone()))
        .unwrap();

    let engine =
        HouseEngine::initialize(config().into_runtime_parts(), persisted, instant(3, 0, 0.0))
            .unwrap();
    assert!(engine.state().scope_state(&living).unwrap().is_on());
    assert!(
        engine
            .state()
            .scope_state(&Scope::House)
            .is_ok_and(|state| !state.is_on())
    );
    assert!(engine.state().scope_state(&stale).is_err());
    assert_eq!(
        engine
            .state()
            .control_state(&control)
            .unwrap()
            .selected_scope(),
        &living
    );
}

#[test]
fn configuration_resets_a_persisted_scope_after_control_permission_is_removed() {
    let control = ControlId::new("living-room-remote").unwrap();
    let mut persisted = AutomationState::default();
    persisted
        .insert_scope(Scope::House, ScopeState::new(false))
        .unwrap();
    persisted
        .insert_control(control.clone(), ControlState::new(Scope::House))
        .unwrap();

    let engine =
        HouseEngine::initialize(config().into_runtime_parts(), persisted, instant(3, 0, 0.0))
            .unwrap();

    assert!(matches!(
        engine
            .state()
            .control_state(&control)
            .unwrap()
            .selected_scope(),
        Scope::Room(_)
    ));
}

#[test]
fn control_alias_migrates_an_authorized_runtime_selected_scope() {
    let input = include_str!("../../examples/house.toml").replace(
        "{ gesture = \"right\", target = \"selected\", action = { kind = \"adjust_color_temperature_offset\", delta_kelvin = 150 } },",
        "{ gesture = \"right\", target = \"whole-house\", action = { kind = \"select_scope\" } },",
    );
    let old_id = ControlId::new("ikea-e1810-example").unwrap();
    let current_id = ControlId::new("living-room-remote").unwrap();
    let mut persisted = AutomationState::default();
    persisted
        .insert_scope(Scope::House, ScopeState::new(false))
        .unwrap();
    persisted
        .insert_control(old_id.clone(), ControlState::new(Scope::House))
        .unwrap();

    let engine = HouseEngine::initialize(
        ValidatedConfig::parse(&input).unwrap().into_runtime_parts(),
        persisted,
        instant(3, 0, 0.0),
    )
    .unwrap();

    assert_eq!(
        engine
            .state()
            .control_state(&current_id)
            .unwrap()
            .selected_scope(),
        &Scope::House
    );
    assert!(engine.state().control_state(&old_id).is_err());
}

#[test]
fn device_alias_resolves_to_the_current_runtime_identity() {
    let mut engine = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        instant(12, 0, 0.0),
    )
    .unwrap();
    engine.recompute_desired(instant(12, 0, 0.0)).unwrap();
    let current = DeviceId::new("reading-light").unwrap();
    let alias = DeviceId::new("ikea-led2111g6-example").unwrap();

    assert_eq!(
        engine.owner_scope(&alias).unwrap(),
        engine.owner_scope(&current).unwrap()
    );
    assert_eq!(engine.target(&alias), engine.target(&current));
}

#[test]
fn sparse_curve_tick_suppresses_subthreshold_updates() {
    let mut engine = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        instant_with_second(12, 0, 0, 0.0),
    )
    .unwrap();
    engine
        .recompute_desired(instant_with_second(12, 0, 0, 0.0))
        .unwrap();
    let (actions, _) = engine
        .recompute_sparse(instant_with_second(12, 0, 1, 1.0))
        .unwrap();
    assert!(actions.is_empty());
}

#[test]
fn startup_merges_topology_and_initializes_reset_marker_before_commands() {
    let engine = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        instant(3, 0, 0.0),
    )
    .unwrap();

    assert_eq!(engine.state().scope_states().len(), 3);
    assert_eq!(engine.state().control_states().len(), 1);
    assert_eq!(
        engine.state().last_reset_date(),
        Some(LocalDate::new(2026, 9, 12).unwrap())
    );
    assert!(engine.startup_state_changed());
}

#[test]
fn room_owner_wins_and_broader_action_fans_out_without_becoming_scheduler_owner() {
    let mut engine = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        instant(12, 0, 0.0),
    )
    .unwrap();
    let device = DeviceId::new("reading-light").unwrap();
    let owner = engine.owner_scope(&device).unwrap().clone();
    assert!(matches!(owner, Scope::Room(_)));

    let house = Scope::House;
    let outcome = engine
        .apply_gesture_for_scope(Gesture::Down, &house, instant(12, 0, 1.0))
        .unwrap();
    let room_offset = engine
        .state()
        .scope_state(&owner)
        .unwrap()
        .offsets()
        .brightness();
    assert_eq!(room_offset, -0.05);
    assert_eq!(outcome.recomputed_devices, 2);
}

#[test]
fn aggregate_circadian_toggle_freezes_all_then_smoothly_unfreezes_all_with_acknowledgements() {
    let mut engine = HouseEngine::initialize(
        config().into_runtime_parts(),
        Default::default(),
        instant(12, 0, 0.0),
    )
    .unwrap();
    engine
        .apply_gesture_for_scope(Gesture::CenterSingle, &Scope::House, instant(12, 0, 0.5))
        .unwrap();

    let frozen = engine
        .apply_gesture_for_scope(Gesture::CenterDouble, &Scope::House, instant(12, 0, 1.0))
        .unwrap();
    assert_eq!(frozen.acknowledged_owner_count, 1);
    assert!(
        engine
            .owner_states()
            .all(|(_, state)| matches!(state.mode(), CurveMode::Frozen { .. }))
    );

    let unfrozen = engine
        .apply_gesture_for_scope(Gesture::CenterDouble, &Scope::House, instant(12, 0, 2.0))
        .unwrap();
    assert_eq!(unfrozen.acknowledged_owner_count, 1);
    assert!(
        engine
            .owner_states()
            .all(|(_, state)| matches!(state.mode(), CurveMode::Converging { .. }))
    );
}

#[test]
fn credential_file_is_parsed_without_shell_evaluation_and_debug_is_redacted() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("mqtt.env");
    fs::write(&path, "MQTT_USERNAME=alice\nMQTT_PASSWORD=$(not-run)\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let source = house_automationd::config::MqttCredentialSource {
        environment_file: path,
        username_variable: "MQTT_USERNAME".to_owned(),
        password_variable: "MQTT_PASSWORD".to_owned(),
    };

    let credentials = load_credentials(&source).unwrap();
    assert_eq!(credentials.username(), "alice");
    assert_eq!(credentials.password(), "$(not-run)");
    let debug = format!("{credentials:?}");
    assert!(!debug.contains("alice"));
    assert!(!debug.contains("not-run"));
}

#[test]
fn health_is_ready_only_after_database_mqtt_and_bridge_are_ready() {
    let health = Arc::new(HealthState::new());
    health.set_database_migrated(true);
    health.set_mqtt_connected(true);
    assert_eq!(health.snapshot().status_code(), 503);
    health.set_bridge_online(true);
    let snapshot: HealthSnapshot = health.snapshot();
    assert_eq!(snapshot.status_code(), 200);
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(!json.contains("reading-light"));
    assert!(!json.contains("password"));
}
