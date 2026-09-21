use house_automation_core::{
    input::{Action, Gesture},
    reconcile::{Availability, DeviceId, DispatchClaim, ReconcileAction, Reconciler},
    state::{MonotonicTime, Scope},
    value::{Brightness, Kelvin, LightTarget},
};
use house_automationd::config::{
    GroupId, MAX_ACKNOWLEDGEMENT_DURATION_MS, MAX_AMBIGUOUS_HOLD_WINDOW_MS,
    MAX_DISPATCH_ACCEPTANCE_MARGIN_SECONDS, MAX_DISPATCH_FAILURE_BACKOFF_SECONDS,
    MAX_DOUBLE_CLICK_WINDOW_MS, MAX_RECONCILE_RETRY_INTERVAL_SECONDS, MAX_SPARSE_REFRESH_SECONDS,
    MAX_SPARSE_TICK_SECONDS, MAX_UNFREEZE_CONVERGENCE_SECONDS, MAX_WHOLE_HOUR_DURATION_MS,
    ValidatedConfig,
};
use house_automationd::zigbee2mqtt::{InboundEvent, InboundMessage, PlanEpoch, Qos};

const EXAMPLE: &str = include_str!("../../examples/house.toml");

#[test]
fn anonymous_example_loads_and_uses_safe_defaults() {
    let config = ValidatedConfig::parse(EXAMPLE).expect("anonymous example must validate");

    assert_eq!(config.application_namespace(), "house/v1");
    assert_eq!(config.double_click_window().seconds(), 0.35);
    assert_eq!(config.ambiguous_hold_window().seconds(), 1.2);
    assert_eq!(config.daily_reset_time().seconds(), 4 * 60 * 60);
    assert_eq!(config.convergence_duration_seconds(), 30.0);
    assert_eq!(config.whole_hour_duration_ms(), 500);
    assert_eq!(config.device_count(), 2);
    assert_eq!(config.control_count(), 1);
}

#[test]
fn debug_redacts_topology_and_credential_references() {
    let source = replace(
        EXAMPLE,
        "password_variable = \"MQTT_PASSWORD\"",
        "password_variable = \"TOP_SECRET_SENTINEL\"",
    );
    let config = ValidatedConfig::parse(&source).unwrap();
    let debug = format!("{config:?}");

    for sensitive in [
        "demo/living-room/reading-light",
        "living-room",
        "/run/credentials/house-automationd.service/mqtt.env",
        "TOP_SECRET_SENTINEL",
    ] {
        assert!(!debug.contains(sensitive), "debug leaked {sensitive}");
    }
}

fn replace(source: &str, old: &str, new: &str) -> String {
    assert!(source.contains(old), "test fixture drift: {old}");
    source.replacen(old, new, 1)
}

fn reject(source: &str) -> String {
    ValidatedConfig::parse(source).unwrap_err().to_string()
}

fn empty_table(source: &str, header: &str) -> String {
    let start = source.find(header).expect("table exists") + header.len();
    let following = &source[start..];
    let end = following
        .find("\n[")
        .map_or(source.len(), |offset| start + offset);
    format!("{}{}{}", &source[..start], "\n", &source[end..])
}

#[test]
fn omitted_operational_fields_use_documented_defaults() {
    let without_namespace = replace(EXAMPLE, "application_namespace = \"house/v1\"\n", "");
    let without_input = empty_table(&without_namespace, "[input]");
    let without_circadian = empty_table(&without_input, "[circadian]");
    let source = empty_table(&without_circadian, "[whole_hour]");
    let config = ValidatedConfig::parse(&source).unwrap();

    assert_eq!(config.application_namespace(), "house/v1");
    assert_eq!(config.double_click_window().seconds(), 0.35);
    assert_eq!(config.ambiguous_hold_window().seconds(), 1.2);
    assert_eq!(config.daily_reset_time().seconds(), 14_400);
    assert_eq!(config.convergence_duration_seconds(), 30.0);
    assert_eq!(config.whole_hour_duration_ms(), 500);
}

#[test]
fn solar_curve_uses_validated_location_and_timezone() {
    let parts = ValidatedConfig::parse(EXAMPLE)
        .unwrap()
        .into_runtime_parts();

    assert_eq!(parts.time_zone.name(), "Europe/Stockholm");
}

#[test]
fn solar_curve_requires_valid_location_and_iana_timezone() {
    let missing_location = replace(
        EXAMPLE,
        "[location]\nlatitude = 59.3\nlongitude = 18.1\ntime_zone = \"Europe/Stockholm\"\n\n",
        "",
    );
    assert!(reject(&missing_location).contains("location"));

    for (old, new, expected) in [
        ("latitude = 59.3", "latitude = 91.0", "latitude"),
        ("longitude = 18.1", "longitude = 181.0", "longitude"),
        (
            "time_zone = \"Europe/Stockholm\"",
            "time_zone = \"Mars/Olympus\"",
            "IANA timezone",
        ),
    ] {
        let source = replace(EXAMPLE, old, new);
        assert!(reject(&source).contains(expected));
    }
}

#[test]
fn curve_kinds_reject_mixed_or_incomplete_fields() {
    let fixed_with_solar_field = replace(
        EXAMPLE,
        "id = \"default-day\"\nanchors = [",
        "id = \"default-day\"\nwake_time = \"07:00\"\nanchors = [",
    );
    assert!(reject(&fixed_with_solar_field).contains("fixed curve"));

    let solar_with_anchors = replace(
        EXAMPLE,
        "wake_time = \"07:00\"",
        "wake_time = \"07:00\"\nanchors = [\n  { time = \"04:00\", brightness = 0.1, color_temperature_kelvin = 2200 },\n  { time = \"12:00\", brightness = 1.0, color_temperature_kelvin = 5000 },\n]",
    );
    assert!(reject(&solar_with_anchors).contains("solar_hybrid curve"));
}

#[test]
fn solar_curve_rejects_invalid_schedule_and_winter_hold() {
    for (old, new, expected) in [
        ("bed_time = \"23:00\"", "bed_time = \"12:00\"", "eight-hour"),
        ("start = \"11-01\"", "start = \"13-01\"", "MM-DD"),
        (
            "reference = \"11-01\"",
            "reference = \"02-01\"",
            "inside hold interval",
        ),
    ] {
        let source = replace(EXAMPLE, old, new);
        assert!(reject(&source).contains(expected));
    }
}

#[test]
fn credential_source_accepts_only_safe_runtime_file_and_environment_names() {
    let cases = [
        replace(
            EXAMPLE,
            "environment_file = \"/run/credentials/house-automationd.service/mqtt.env\"",
            "environment_file = \"relative/mqtt.env\"",
        ),
        replace(
            EXAMPLE,
            "environment_file = \"/run/credentials/house-automationd.service/mqtt.env\"",
            "environment_file = \"/nix/store/plaintext-mqtt.env\"",
        ),
        replace(
            EXAMPLE,
            "environment_file = \"/run/credentials/house-automationd.service/mqtt.env\"",
            "environment_file = \"/run/credentials/bad\\npath\"",
        ),
        replace(
            EXAMPLE,
            "environment_file = \"/run/credentials/house-automationd.service/mqtt.env\"",
            "environment_file = \"/run/../nix/store/plaintext-mqtt.env\"",
        ),
        replace(
            EXAMPLE,
            "environment_file = \"/run/credentials/house-automationd.service/mqtt.env\"",
            "environment_file = \"/run/./credentials/mqtt.env\"",
        ),
        replace(
            EXAMPLE,
            "username_variable = \"MQTT_USERNAME\"",
            "username_variable = \"bad-name\"",
        ),
        replace(
            EXAMPLE,
            "username_variable = \"MQTT_USERNAME\"",
            "username_variable = \"MQTT_PASSWORD\"",
        ),
    ];

    for source in cases {
        assert!(ValidatedConfig::parse(&source).is_err());
    }
}

#[cfg(unix)]
#[test]
fn existing_credential_symlink_into_nix_store_is_rejected_without_path_leak() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let link = directory.path().join("credential-link");
    symlink("/nix/store", &link).unwrap();
    let source = replace(
        EXAMPLE,
        "/run/credentials/house-automationd.service/mqtt.env",
        link.to_str().unwrap(),
    );
    let error = reject(&source);

    assert!(error.contains("Nix store"));
    assert!(!error.contains(link.to_str().unwrap()));
}

#[test]
fn e1810_mapping_is_declarative_and_acknowledges_circadian_toggle() {
    let parts = ValidatedConfig::parse(EXAMPLE)
        .unwrap()
        .into_runtime_parts();
    let control = &parts.controls[0];

    let Action::AdjustBrightnessOffset(up) = control.mapping.entry(Gesture::Up).unwrap().action()
    else {
        panic!("up must adjust brightness offset")
    };
    assert_eq!(up.get(), 0.05);
    let Action::AdjustColorTemperatureOffset(left) =
        control.mapping.entry(Gesture::Left).unwrap().action()
    else {
        panic!("left must adjust color-temperature offset")
    };
    assert_eq!(left.get(), -150.0);
    assert_eq!(
        control
            .mapping
            .entry(Gesture::CenterSingle)
            .unwrap()
            .action(),
        Action::TogglePower
    );
    assert_eq!(
        control
            .mapping
            .entry(Gesture::CenterDouble)
            .unwrap()
            .action(),
        Action::ToggleCircadian
    );
    assert_eq!(
        control.acknowledgement_gestures,
        [Gesture::CenterDouble].into_iter().collect()
    );
    assert!(matches!(control.selected_scope, Scope::Room(_)));
    assert!(
        parts
            .scopes
            .iter()
            .any(|scope| matches!(scope.scope, Scope::Room(_)))
    );
    assert!(
        parts
            .scopes
            .iter()
            .any(|scope| matches!(scope.scope, Scope::Floor(_)))
    );
    assert!(
        parts
            .scopes
            .iter()
            .any(|scope| matches!(scope.scope, Scope::House))
    );
}

#[test]
fn controls_reject_actions_unsupported_by_every_device_in_the_target_scope() {
    let source = replace(
        EXAMPLE,
        "selected_scope = \"living-room-lights\"",
        "selected_scope = \"relay-room-lights\"",
    ) + "\n[[rooms]]\nid = \"relay-room\"\nfloor = \"ground-floor\"\n\n[[scopes]]\nid = \"relay-room-lights\"\nkind = \"room\"\nroom = \"relay-room\"\ncurve = \"default-day\"\n\n[[devices]]\nid = \"relay\"\nfriendly_name = \"demo/relay-room/relay\"\nroom = \"relay-room\"\ncapabilities = { on_off = true }\n";

    let error = reject(&source);

    assert!(error.contains("controls.mappings.action"));
    assert!(!error.contains("relay-room"));
}

#[test]
fn circadian_mode_remains_valid_for_a_scope_that_degrades_to_on_off_only() {
    let source = replace(
        EXAMPLE,
        "selected_scope = \"living-room-lights\"",
        "selected_scope = \"relay-room-lights\"",
    );
    let source = replace(
        &source,
        "  { gesture = \"up\", target = \"selected\", action = { kind = \"adjust_brightness_offset\", delta = 0.05 } },\n  { gesture = \"down\", target = \"selected\", action = { kind = \"adjust_brightness_offset\", delta = -0.05 } },\n  { gesture = \"left\", target = \"selected\", action = { kind = \"adjust_color_temperature_offset\", delta_kelvin = -150 } },\n  { gesture = \"right\", target = \"selected\", action = { kind = \"adjust_color_temperature_offset\", delta_kelvin = 150 } },\n  { gesture = \"center_single\", target = \"selected\", action = { kind = \"toggle_power\" } },\n  { gesture = \"center_double\", target = \"selected\", action = { kind = \"toggle_circadian_with_acknowledgement\" } },",
        "  { gesture = \"center_single\", target = \"selected\", action = { kind = \"toggle_power\" } },\n  { gesture = \"center_double\", target = \"selected\", action = { kind = \"toggle_circadian_with_acknowledgement\" } },",
    ) + "\n[[rooms]]\nid = \"relay-room\"\nfloor = \"ground-floor\"\n\n[[scopes]]\nid = \"relay-room-lights\"\nkind = \"room\"\nroom = \"relay-room\"\ncurve = \"default-day\"\n\n[[devices]]\nid = \"relay\"\nfriendly_name = \"demo/relay-room/relay\"\nroom = \"relay-room\"\ncapabilities = { on_off = true }\n";

    let parts = ValidatedConfig::parse(&source)
        .expect("circadian state must survive capability degradation")
        .into_runtime_parts();

    let mapping = &parts.controls[0].mapping;
    assert!(mapping.entry(Gesture::CenterSingle).is_some());
    assert!(mapping.entry(Gesture::CenterDouble).is_some());
    assert!(mapping.entry(Gesture::Up).is_none());
}

#[test]
fn typed_runtime_topology_preserves_primary_ids_group_ids_and_members() {
    let parts = ValidatedConfig::parse(EXAMPLE)
        .unwrap()
        .into_runtime_parts();

    assert_eq!(parts.devices[0].id, DeviceId::new("reading-light").unwrap());
    assert_eq!(
        parts.devices[0].aliases,
        [DeviceId::new("ikea-led2111g6-example").unwrap()]
    );
    assert_ne!(parts.devices[0].id, parts.devices[0].aliases[0]);
    assert_eq!(
        parts.groups[0].id,
        GroupId::new("living-room-zigbee").unwrap()
    );
    assert_eq!(
        parts.groups[0].members,
        [
            DeviceId::new("reading-light").unwrap(),
            DeviceId::new("color-light").unwrap(),
        ]
    );
    assert_eq!(parts.groups[0].mired_range, None);
}

#[test]
fn parsed_group_without_mired_uses_group_power_and_brightness_with_device_cct_fallbacks() {
    let parts = ValidatedConfig::parse(EXAMPLE)
        .unwrap()
        .into_runtime_parts();
    let group = parts.groups[0].id.clone();
    let definitions = parts
        .devices
        .iter()
        .map(|device| device.definition.clone())
        .collect();
    let groups = parts
        .groups
        .iter()
        .map(|group| group.definition.clone())
        .collect();
    let mut reconciler = Reconciler::new(definitions, groups, parts.retry_policy).unwrap();
    let at = |seconds| MonotonicTime::from_seconds(seconds).unwrap();
    reconciler.broker_connected(at(0.0)).unwrap();
    for device in &parts.devices {
        reconciler
            .set_device_availability(&device.id, Availability::Online, at(0.0))
            .unwrap();
    }
    reconciler
        .set_bridge_availability(Availability::Online, at(0.0))
        .unwrap();
    let actions = reconciler
        .set_group_desired(
            &group,
            LightTarget {
                on: true,
                brightness: Some(Brightness::new(0.6).unwrap()),
                color_temperature: Some(Kelvin::new(3000.0).unwrap()),
                color: None,
                transition_ms: None,
            },
            at(1.0),
        )
        .unwrap();
    let plan = parts
        .zigbee2mqtt
        .apply_actions(PlanEpoch::new(at(1.0)), &actions)
        .expect("validated optional group mired must remain command-encodable");
    let publications: Vec<_> = plan
        .operations()
        .iter()
        .filter_map(|operation| operation.publication())
        .collect();

    assert_eq!(publications.len(), 3);
    let group_publication = publications
        .iter()
        .find(|publication| publication.topic().contains("demo/living-room/lights/set"))
        .unwrap();
    let group_payload: serde_json::Value =
        serde_json::from_slice(group_publication.payload()).unwrap();
    assert_eq!(group_payload["state"], "ON");
    assert!(group_payload["brightness"].is_number());
    assert!(group_payload.get("color_temp").is_none());
    for device in ["reading-light", "color-light"] {
        let publication = publications
            .iter()
            .find(|publication| publication.topic().contains(device))
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(publication.payload()).unwrap();
        assert!(payload["color_temp"].is_number());
        assert!(payload.get("state").is_none());
        assert!(payload.get("brightness").is_none());
    }

    assert_eq!(plan.dispatch_plans().len(), 1);
    let metadata = plan.dispatch_plans()[0];
    assert_eq!(metadata.operation_count(), publications.len());
    reconciler
        .register_dispatch_plan(
            metadata.token(),
            plan.epoch().monotonic_time(),
            metadata.operation_count(),
            metadata.max_offset_ms(),
        )
        .unwrap();
    for publication in publications {
        let token = publication.dispatch_token().unwrap();
        let index = publication.dispatch_operation_index().unwrap();
        let DispatchClaim::Ready(permit) = reconciler.claim_next_operation(token, index).unwrap()
        else {
            panic!("every translated fallback command must remain claimable")
        };
        permit.accepted(at(1.1)).unwrap();
    }
    assert!(!reconciler.is_dispatch_token_valid(metadata.token()));
}

#[test]
fn duplicate_ids_aliases_and_friendly_names_are_rejected() {
    let duplicate_id = format!(
        "{EXAMPLE}\n[[devices]]\nid = \"reading-light\"\naliases = []\nfriendly_name = \"demo/spare\"\nroom = \"living-room\"\ncapabilities = {{ on_off = true }}\n"
    );
    assert!(reject(&duplicate_id).contains("duplicate"));

    let duplicate_alias = replace(
        EXAMPLE,
        "aliases = [\"hue-color-example\"]",
        "aliases = [\"ikea-led2111g6-example\"]",
    );
    assert!(reject(&duplicate_alias).contains("duplicate"));

    let duplicate_friendly = replace(
        EXAMPLE,
        "friendly_name = \"demo/living-room/color-light\"",
        "friendly_name = \"demo/living-room/reading-light\"",
    );
    assert!(reject(&duplicate_friendly).contains("duplicate"));
}

#[test]
fn a_device_can_belong_to_only_one_native_group() {
    let source = format!(
        "{EXAMPLE}\n[[groups]]\nid = \"second-group\"\nfriendly_name = \"demo/second-group\"\nmembers = [\"reading-light\"]\ncapabilities = {{ on_off = true }}\n"
    );

    assert!(reject(&source).contains("at most one Zigbee group"));
}

#[test]
fn mqtt_namespaces_reject_wildcards_reserved_components_and_overlap() {
    for source in [
        replace(
            EXAMPLE,
            "application_namespace = \"house/v1\"",
            "application_namespace = \"house/+/v1\"",
        ),
        replace(
            EXAMPLE,
            "application_namespace = \"house/v1\"",
            "application_namespace = \"house/set/v1\"",
        ),
        replace(
            EXAMPLE,
            "application_namespace = \"house/v1\"",
            "application_namespace = \"zigbee2mqtt/app/v1\"",
        ),
        replace(
            EXAMPLE,
            "zigbee2mqtt_base_topic = \"zigbee2mqtt\"",
            "zigbee2mqtt_base_topic = \"bad/#\"",
        ),
    ] {
        assert!(reject(&source).contains("mqtt"));
    }
}

#[test]
fn application_namespace_requires_nonzero_terminal_version() {
    for namespace in [
        "house",
        "house/v0",
        "house/v00",
        "house/v01",
        "house/version1",
        "house/v1/events",
    ] {
        let source = replace(
            EXAMPLE,
            "application_namespace = \"house/v1\"",
            &format!("application_namespace = \"{namespace}\""),
        );
        assert!(reject(&source).contains("version"));
    }

    for namespace in ["house/v1", "house/v10"] {
        let source = replace(
            EXAMPLE,
            "application_namespace = \"house/v1\"",
            &format!("application_namespace = \"{namespace}\""),
        );
        ValidatedConfig::parse(&source).expect("canonical nonzero version must validate");
    }
}

#[test]
fn selected_is_reserved_from_configured_scope_ids() {
    let source = EXAMPLE.replace("living-room-lights", "selected");

    assert!(reject(&source).contains("reserved"));
}

#[test]
fn dangling_topology_references_are_rejected() {
    let cases = [
        replace(
            EXAMPLE,
            "floor = \"ground-floor\"",
            "floor = \"missing-floor\"",
        ),
        replace(
            EXAMPLE,
            "room = \"living-room\"\nsingle_transition_attribute",
            "room = \"missing-room\"\nsingle_transition_attribute",
        ),
        replace(
            EXAMPLE,
            "members = [\"reading-light\", \"color-light\"]",
            "members = [\"missing-device\"]",
        ),
        replace(
            EXAMPLE,
            "curve = \"default-day\"",
            "curve = \"missing-curve\"",
        ),
        replace(
            EXAMPLE,
            "selected_scope = \"living-room-lights\"",
            "selected_scope = \"missing-scope\"",
        ),
        replace(
            EXAMPLE,
            "target = \"selected\"",
            "target = \"missing-scope\"",
        ),
    ];
    for source in cases {
        assert!(reject(&source).contains("unknown"));
    }
}

#[test]
fn empty_topology_objects_are_rejected() {
    let empty_group = replace(
        EXAMPLE,
        "members = [\"reading-light\", \"color-light\"]",
        "members = []",
    );
    assert!(reject(&empty_group).contains("must not be empty"));

    let empty_curve = replace(
        EXAMPLE,
        "anchors = [\n  { time = \"04:00\", brightness = 0.10, color_temperature_kelvin = 2200 },\n  { time = \"08:00\", brightness = 0.75, color_temperature_kelvin = 4000 },\n  { time = \"13:00\", brightness = 1.00, color_temperature_kelvin = 5000 },\n  { time = \"19:00\", brightness = 0.55, color_temperature_kelvin = 3000 },\n  { time = \"23:00\", brightness = 0.20, color_temperature_kelvin = 2400 },\n]",
        "anchors = []",
    );
    assert!(reject(&empty_curve).contains("at least two anchors"));

    let empty_scope = replace(
        &format!("{EXAMPLE}\n[[rooms]]\nid = \"empty-room\"\nfloor = \"ground-floor\"\n"),
        "room = \"living-room\"\ncurve = \"default-day\"",
        "room = \"empty-room\"\ncurve = \"default-day\"",
    );
    assert!(reject(&empty_scope).contains("at least one device"));

    let sensor_only_scope = format!(
        "{empty_scope}\n[[devices]]\nid = \"temperature-sensor\"\naliases = []\nfriendly_name = \"demo/empty-room/temperature\"\nroom = \"empty-room\"\ncapabilities = {{ temperature = true }}\n"
    );
    assert!(
        reject(&sensor_only_scope).contains("controllable light"),
        "input and sensor devices must not make a lighting scope non-empty"
    );
}

#[test]
fn malformed_and_duplicate_curve_anchors_are_rejected() {
    let malformed = replace(EXAMPLE, "time = \"04:00\"", "time = \"4:00\"");
    assert!(reject(&malformed).contains("HH:MM"));

    let duplicate = replace(EXAMPLE, "time = \"08:00\"", "time = \"04:00\"");
    assert!(reject(&duplicate).contains("unique times"));
}

#[test]
fn invalid_capabilities_ranges_and_gamut_are_rejected() {
    let no_capabilities = replace(
        EXAMPLE,
        "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454 } }",
        "capabilities = {}",
    );
    assert!(reject(&no_capabilities).contains("capability"));

    let bad_range = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 6500",
        "minimum_kelvin = 6500, maximum_kelvin = 2200",
    );
    assert!(reject(&bad_range).contains("Kelvin range"));

    let bad_gamut = replace(
        EXAMPLE,
        "green = [0.1700, 0.7000]",
        "green = [0.6915, 0.3083]",
    );
    assert!(reject(&bad_gamut).contains("non-collinear"));

    let dimming_without_power = replace(
        EXAMPLE,
        "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454 } }",
        "capabilities = { dimming = true }",
    );
    assert!(reject(&dimming_without_power).contains("require on_off"));
}

#[test]
fn group_capabilities_cannot_exceed_members_and_optional_mired_is_all_or_nothing() {
    let explicit_mired = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000 } }\n\n[[controls]]",
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454 } }\n\n[[controls]]",
    );
    ValidatedConfig::parse(&explicit_mired).expect("consistent group mired bounds may be declared");

    let exceeds_member = replace(
        EXAMPLE,
        "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 4000 } }\n\n[[controls]]",
        "capabilities = { on_off = true, dimming = true, color_xy = true }\n\n[[controls]]",
    );
    let exceeds_member = replace(
        &exceeds_member,
        "members = [\"reading-light\", \"color-light\"]\nsingle_transition_attribute = true",
        "members = [\"reading-light\", \"color-light\"]\nsingle_transition_attribute = false",
    );
    assert!(reject(&exceeds_member).contains("every member"));

    let no_cct = replace(
        EXAMPLE,
        "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 4000 } }\n\n[[controls]]",
        "capabilities = { on_off = true, dimming = true }\n\n[[controls]]",
    );
    let no_cct = replace(
        &no_cct,
        "members = [\"reading-light\", \"color-light\"]\nsingle_transition_attribute = true",
        "members = [\"reading-light\", \"color-light\"]\nsingle_transition_attribute = false",
    );
    ValidatedConfig::parse(&no_cct).expect("non-CCT group needs no mired bounds");

    let one_mired_endpoint = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000 } }\n\n[[controls]]",
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250 } }\n\n[[controls]]",
    );
    assert!(reject(&one_mired_endpoint).contains("both be present"));

    let wider_than_members = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000 } }\n\n[[controls]]",
        "minimum_kelvin = 1500, maximum_kelvin = 8000 } }\n\n[[controls]]",
    );
    assert!(
        reject(&wider_than_members).contains("every member"),
        "group command range must fit every member"
    );

    let narrower_member_mired = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454",
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 252, maximum_mired = 452",
    );
    let wider_mired_than_member = replace(
        &narrower_member_mired,
        "minimum_kelvin = 2200, maximum_kelvin = 4000 } }\n\n[[controls]]",
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454 } }\n\n[[controls]]",
    );
    assert!(reject(&wider_mired_than_member).contains("every member"));

    let malformed_mired = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000 } }\n\n[[controls]]",
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 0, maximum_mired = 454 } }\n\n[[controls]]",
    );
    assert!(reject(&malformed_mired).contains("mired range"));

    let device_without_mired = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454",
        "minimum_kelvin = 2200, maximum_kelvin = 4000",
    );
    assert!(reject(&device_without_mired).contains("device CCT"));
}

#[test]
fn cct_kelvin_and_mired_endpoints_must_round_trip_within_reconcile_tolerance() {
    let contradictory_device = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 6500, minimum_mired = 153, maximum_mired = 454",
        "minimum_kelvin = 2200, maximum_kelvin = 6500, minimum_mired = 250, maximum_mired = 454",
    );
    assert!(reject(&contradictory_device).contains("round-trip"));

    let contradictory_group = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000 } }\n\n[[controls]]",
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 300, maximum_mired = 454 } }\n\n[[controls]]",
    );
    assert!(reject(&contradictory_group).contains("round-trip"));

    let implausibly_broad_mired = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454",
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 1, maximum_mired = 65535",
    );
    assert!(reject(&implausibly_broad_mired).contains("round-trip"));

    ValidatedConfig::parse(EXAMPLE)
        .expect("2200 K and 454 mired realistic endpoint quantization stays within 1%");
}

#[test]
fn validated_device_cct_endpoints_round_trip_through_real_adapter_contract() {
    for endpoint in [2200.0, 4000.0] {
        let parts = ValidatedConfig::parse(EXAMPLE)
            .unwrap()
            .into_runtime_parts();
        let definitions = parts
            .devices
            .iter()
            .map(|device| device.definition.clone())
            .collect();
        let groups = parts
            .groups
            .iter()
            .map(|group| group.definition.clone())
            .collect();
        let mut reconciler = Reconciler::new(definitions, groups, parts.retry_policy).unwrap();
        let at = |seconds| MonotonicTime::from_seconds(seconds).unwrap();
        reconciler.broker_connected(at(0.0)).unwrap();
        reconciler
            .set_device_availability(
                &DeviceId::new("reading-light").unwrap(),
                Availability::Online,
                at(0.0),
            )
            .unwrap();
        reconciler
            .set_bridge_availability(Availability::Online, at(0.0))
            .unwrap();
        let actions = reconciler
            .set_device_desired(
                &DeviceId::new("reading-light").unwrap(),
                LightTarget {
                    on: true,
                    brightness: None,
                    color_temperature: Some(Kelvin::new(endpoint).unwrap()),
                    color: None,
                    transition_ms: None,
                },
                at(1.0),
            )
            .unwrap();
        assert!(matches!(
            actions.as_slice(),
            [ReconcileAction::Command { .. }]
        ));
        let plan = parts
            .zigbee2mqtt
            .apply_actions(PlanEpoch::new(at(1.0)), &actions)
            .unwrap();
        let publication = plan
            .operations()
            .iter()
            .find_map(|operation| operation.publication())
            .unwrap();
        let command: serde_json::Value = serde_json::from_slice(publication.payload()).unwrap();
        let mired = command["color_temp"].as_u64().unwrap();
        let state_topic = publication.topic().strip_suffix("/set").unwrap();
        let observed_payload = serde_json::to_vec(
            &serde_json::json!({"color_temp": mired, "color_mode": "color_temp"}),
        )
        .unwrap();
        let event = parts
            .zigbee2mqtt
            .parse(&InboundMessage::new(
                state_topic,
                &observed_payload,
                false,
                false,
                Qos::AtLeastOnce,
            ))
            .unwrap()
            .unwrap();
        let InboundEvent::DeviceState { state, .. } = event else {
            panic!("state topic must produce device state")
        };
        let observed = state.color_temperature.unwrap().get();
        assert!((endpoint - observed).abs() <= endpoint * 0.01);
    }
}

#[test]
fn color_policy_and_transition_quirks_require_matching_capabilities() {
    let color_policy_without_color = replace(
        EXAMPLE,
        "single_transition_attribute = true\ncapabilities = { on_off = true, dimming = true, color_temperature",
        "single_transition_attribute = true\ncolor_comparison = { xy_tolerance = 0.03, achromatic_saturation_threshold = 0.02, gamut = { red = [0.6915, 0.3083], green = [0.1700, 0.7000], blue = [0.1532, 0.0475] } }\ncapabilities = { on_off = true, dimming = true, color_temperature",
    );
    assert!(reject(&color_policy_without_color).contains("color capability"));

    let transition_quirk_without_both_attributes = replace(
        EXAMPLE,
        "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454 } }",
        "capabilities = { on_off = true, dimming = true }",
    );
    assert!(reject(&transition_quirk_without_both_attributes).contains("transition"));
}

#[test]
fn unsupported_or_duplicate_control_mappings_are_rejected() {
    let bad_gesture = replace(EXAMPLE, "gesture = \"up\"", "gesture = \"triple_tap\"");
    assert!(reject(&bad_gesture).contains("unsupported gesture"));

    let bad_action = replace(
        EXAMPLE,
        "kind = \"toggle_power\"",
        "kind = \"run_vendor_scene\"",
    );
    assert!(reject(&bad_action).contains("schema"));

    let duplicate = replace(EXAMPLE, "gesture = \"down\"", "gesture = \"up\"");
    assert!(reject(&duplicate).contains("only one mapping"));

    let invalid_select = replace(
        EXAMPLE,
        "action = { kind = \"toggle_power\" }",
        "action = { kind = \"select_scope\" }",
    );
    assert!(reject(&invalid_select).contains("combination"));

    let excessive_delta = replace(EXAMPLE, "delta = 0.05", "delta = 2.0");
    assert!(reject(&excessive_delta).contains("between -1 and 1"));

    let no_op_delta = replace(EXAMPLE, "delta_kelvin = 150", "delta_kelvin = 0");
    assert!(reject(&no_op_delta).contains("non-zero"));
}

#[test]
fn timing_windows_thresholds_and_durations_are_validated() {
    let cases = [
        replace(
            EXAMPLE,
            "double_click_window_ms = 350",
            "double_click_window_ms = 0",
        ),
        replace(
            EXAMPLE,
            "ambiguous_center_hold_window_ms = 1200",
            "ambiguous_center_hold_window_ms = 200",
        ),
        replace(
            EXAMPLE,
            "unfreeze_convergence_seconds = 30",
            "unfreeze_convergence_seconds = 0",
        ),
        replace(EXAMPLE, "tick_seconds = 30", "tick_seconds = 0"),
        replace(
            EXAMPLE,
            "maximum_refresh_seconds = 300",
            "maximum_refresh_seconds = 10",
        ),
        replace(EXAMPLE, "duration_ms = 180", "duration_ms = 0"),
        replace(EXAMPLE, "duration_ms = 500", "duration_ms = 0"),
        replace(
            EXAMPLE,
            "retry_interval_seconds = 5",
            "retry_interval_seconds = 0",
        ),
    ];
    for source in cases {
        assert!(ValidatedConfig::parse(&source).is_err());
    }
}

#[test]
fn every_operational_duration_accepts_ceiling_and_rejects_just_over() {
    let mut ceiling = EXAMPLE.to_owned();
    for (old, new) in [
        (
            "double_click_window_ms = 350".to_owned(),
            format!("double_click_window_ms = {MAX_DOUBLE_CLICK_WINDOW_MS}"),
        ),
        (
            "ambiguous_center_hold_window_ms = 1200".to_owned(),
            format!("ambiguous_center_hold_window_ms = {MAX_AMBIGUOUS_HOLD_WINDOW_MS}"),
        ),
        (
            "unfreeze_convergence_seconds = 30".to_owned(),
            format!("unfreeze_convergence_seconds = {MAX_UNFREEZE_CONVERGENCE_SECONDS}"),
        ),
        (
            "tick_seconds = 30".to_owned(),
            format!("tick_seconds = {MAX_SPARSE_TICK_SECONDS}"),
        ),
        (
            "maximum_refresh_seconds = 300".to_owned(),
            format!("maximum_refresh_seconds = {MAX_SPARSE_REFRESH_SECONDS}"),
        ),
        (
            "duration_ms = 180\npriority = 100".to_owned(),
            format!("duration_ms = {MAX_ACKNOWLEDGEMENT_DURATION_MS}\npriority = 100"),
        ),
        (
            "duration_ms = 500\npriority = 10".to_owned(),
            format!("duration_ms = {MAX_WHOLE_HOUR_DURATION_MS}\npriority = 10"),
        ),
        (
            "retry_interval_seconds = 5".to_owned(),
            format!("retry_interval_seconds = {MAX_RECONCILE_RETRY_INTERVAL_SECONDS}"),
        ),
        (
            "dispatch_acceptance_margin_seconds = 5".to_owned(),
            format!(
                "dispatch_acceptance_margin_seconds = {MAX_DISPATCH_ACCEPTANCE_MARGIN_SECONDS}"
            ),
        ),
        (
            "dispatch_failure_backoff_seconds = 0.5".to_owned(),
            format!("dispatch_failure_backoff_seconds = {MAX_DISPATCH_FAILURE_BACKOFF_SECONDS}"),
        ),
    ] {
        ceiling = replace(&ceiling, &old, &new);
    }
    let parts = ValidatedConfig::parse(&ceiling)
        .expect("every exact ceiling must validate")
        .into_runtime_parts();
    for seconds in [
        parts.input.double_click_window.seconds(),
        parts.input.ambiguous_hold_window.seconds(),
        parts.circadian.convergence_duration_seconds,
        parts.circadian.tick_seconds,
        parts.circadian.maximum_refresh_seconds,
        parts.reconciliation_timing.retry_interval_seconds,
        parts
            .reconciliation_timing
            .dispatch_acceptance_margin_seconds,
        parts.reconciliation_timing.dispatch_failure_backoff_seconds,
    ] {
        std::time::Duration::try_from_secs_f64(seconds)
            .expect("bounded validated duration converts without panic");
    }
    let _ = std::time::Duration::from_millis(parts.acknowledgement_duration_ms);
    let _ = std::time::Duration::from_millis(parts.whole_hour.duration_ms);

    let just_over = [
        (
            "double_click_window_ms = 350",
            format!(
                "double_click_window_ms = {}",
                MAX_DOUBLE_CLICK_WINDOW_MS + 1
            ),
        ),
        (
            "ambiguous_center_hold_window_ms = 1200",
            format!(
                "ambiguous_center_hold_window_ms = {}",
                MAX_AMBIGUOUS_HOLD_WINDOW_MS + 1
            ),
        ),
        (
            "unfreeze_convergence_seconds = 30",
            format!(
                "unfreeze_convergence_seconds = {}",
                MAX_UNFREEZE_CONVERGENCE_SECONDS + 1.0
            ),
        ),
        (
            "tick_seconds = 30",
            format!("tick_seconds = {}", MAX_SPARSE_TICK_SECONDS + 1.0),
        ),
        (
            "maximum_refresh_seconds = 300",
            format!(
                "maximum_refresh_seconds = {}",
                MAX_SPARSE_REFRESH_SECONDS + 1.0
            ),
        ),
        (
            "duration_ms = 180\npriority = 100",
            format!(
                "duration_ms = {}\npriority = 100",
                MAX_ACKNOWLEDGEMENT_DURATION_MS + 1
            ),
        ),
        (
            "duration_ms = 500\npriority = 10",
            format!(
                "duration_ms = {}\npriority = 10",
                MAX_WHOLE_HOUR_DURATION_MS + 1
            ),
        ),
        (
            "retry_interval_seconds = 5",
            format!(
                "retry_interval_seconds = {}",
                MAX_RECONCILE_RETRY_INTERVAL_SECONDS + 1.0
            ),
        ),
        (
            "dispatch_acceptance_margin_seconds = 5",
            format!(
                "dispatch_acceptance_margin_seconds = {}",
                MAX_DISPATCH_ACCEPTANCE_MARGIN_SECONDS + 1.0
            ),
        ),
        (
            "dispatch_failure_backoff_seconds = 0.5",
            format!(
                "dispatch_failure_backoff_seconds = {}",
                MAX_DISPATCH_FAILURE_BACKOFF_SECONDS + 1.0
            ),
        ),
    ];
    for (old, new) in just_over {
        assert!(ValidatedConfig::parse(&replace(EXAMPLE, old, &new)).is_err());
    }
}

#[test]
fn huge_finite_float_durations_are_rejected() {
    for field in [
        "unfreeze_convergence_seconds = 30",
        "tick_seconds = 30",
        "maximum_refresh_seconds = 300",
        "retry_interval_seconds = 5",
        "dispatch_acceptance_margin_seconds = 5",
        "dispatch_failure_backoff_seconds = 0.5",
    ] {
        let name = field.split(" = ").next().unwrap();
        let source = replace(EXAMPLE, field, &format!("{name} = 1e308"));
        assert!(ValidatedConfig::parse(&source).is_err());
    }
}

#[test]
fn every_f64_operational_duration_accepts_one_millisecond_minimum() {
    let mut source = EXAMPLE.to_owned();
    for (field, value) in [
        ("unfreeze_convergence_seconds", "30"),
        ("tick_seconds", "30"),
        ("maximum_refresh_seconds", "300"),
        ("retry_interval_seconds", "5"),
        ("dispatch_acceptance_margin_seconds", "5"),
        ("dispatch_failure_backoff_seconds", "0.5"),
    ] {
        source = replace(
            &source,
            &format!("{field} = {value}"),
            &format!("{field} = 0.001"),
        );
    }
    let parts = ValidatedConfig::parse(&source)
        .expect("one millisecond is the inclusive operational minimum")
        .into_runtime_parts();

    for seconds in [
        parts.circadian.convergence_duration_seconds,
        parts.circadian.tick_seconds,
        parts.circadian.maximum_refresh_seconds,
        parts.reconciliation_timing.retry_interval_seconds,
        parts
            .reconciliation_timing
            .dispatch_acceptance_margin_seconds,
        parts.reconciliation_timing.dispatch_failure_backoff_seconds,
    ] {
        let duration = std::time::Duration::try_from_secs_f64(seconds)
            .expect("validated duration must convert without panic");
        assert!(!duration.is_zero());
    }
}

#[test]
fn every_f64_operational_duration_rejects_sub_millisecond_values() {
    for field in [
        "unfreeze_convergence_seconds = 30",
        "tick_seconds = 30",
        "maximum_refresh_seconds = 300",
        "retry_interval_seconds = 5",
        "dispatch_acceptance_margin_seconds = 5",
        "dispatch_failure_backoff_seconds = 0.5",
    ] {
        let name = field.split(" = ").next().unwrap();
        for too_small in ["0.000999", "5e-324"] {
            let source = replace(EXAMPLE, field, &format!("{name} = {too_small}"));
            assert!(
                ValidatedConfig::parse(&source).is_err(),
                "accepted sub-millisecond {name} = {too_small}"
            );
        }
    }
}

#[test]
fn every_f64_operational_duration_rejects_nan() {
    for field in [
        "unfreeze_convergence_seconds = 30",
        "tick_seconds = 30",
        "maximum_refresh_seconds = 300",
        "retry_interval_seconds = 5",
        "dispatch_acceptance_margin_seconds = 5",
        "dispatch_failure_backoff_seconds = 0.5",
    ] {
        let name = field.split(" = ").next().unwrap();
        let source = replace(EXAMPLE, field, &format!("{name} = nan"));
        assert!(
            ValidatedConfig::parse(&source).is_err(),
            "accepted non-finite {name}"
        );
    }
}

#[test]
fn health_defaults_loopback_and_requires_explicit_non_loopback_opt_in() {
    let parts = ValidatedConfig::parse(EXAMPLE)
        .unwrap()
        .into_runtime_parts();
    assert!(parts.health.bind.ip().is_loopback());

    let denied = replace(
        EXAMPLE,
        "bind = \"127.0.0.1:9876\"",
        "bind = \"192.0.2.10:9876\"",
    );
    assert!(reject(&denied).contains("allow_non_loopback"));

    let allowed = replace(
        &denied,
        "allow_non_loopback = false",
        "allow_non_loopback = true",
    );
    ValidatedConfig::parse(&allowed).expect("explicit concrete private bind is accepted");

    let wildcard = replace(
        EXAMPLE,
        "bind = \"127.0.0.1:9876\"",
        "bind = \"0.0.0.0:9876\"",
    );
    let wildcard = replace(
        &wildcard,
        "allow_non_loopback = false",
        "allow_non_loopback = true",
    );
    assert!(reject(&wildcard).contains("wildcard"));
}

#[test]
fn unknown_fields_inline_secrets_and_solar_coordinates_are_rejected() {
    for injected in [
        "password = \"super-secret-sentinel\"\n",
        "token = \"super-secret-sentinel\"\n",
        "latitude = \"PRIVATE_LOCATION_SENTINEL\"\nlongitude = \"PRIVATE_LOCATION_SENTINEL\"\n",
    ] {
        let source = replace(EXAMPLE, "[input]", &format!("{injected}\n[input]"));
        let error = reject(&source);
        assert!(error.contains("schema"));
        assert!(!error.contains("super-secret-sentinel"));
        assert!(!error.contains("PRIVATE_LOCATION_SENTINEL"));
    }
}

#[test]
fn parser_rejects_unknown_nested_fields_without_echoing_input() {
    let source = replace(
        EXAMPLE,
        "password_variable = \"MQTT_PASSWORD\"",
        "password_variable = \"MQTT_PASSWORD\"\nsecret_value = \"do-not-echo-sentinel\"",
    );
    let error = reject(&source);

    assert!(error.contains("schema"));
    assert!(!error.contains("do-not-echo-sentinel"));
}

#[test]
fn oversized_input_is_rejected_before_toml_parsing() {
    let source = "x".repeat(1024 * 1024 + 1);
    let error = reject(&source);

    assert!(error.contains("byte limit"));
}
