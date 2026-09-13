use house_automation_core::{
    input::{Action, Gesture},
    state::Scope,
};
use house_automationd::config::ValidatedConfig;

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
    for namespace in ["house", "house/v0", "house/version1", "house/v1/events"] {
        let source = replace(
            EXAMPLE,
            "application_namespace = \"house/v1\"",
            &format!("application_namespace = \"{namespace}\""),
        );
        assert!(reject(&source).contains("version"));
    }
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
fn group_capabilities_cannot_exceed_members_and_cct_needs_bounds() {
    let exceeds_member = replace(
        EXAMPLE,
        "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454 } }\n\n[[controls]]",
        "capabilities = { on_off = true, dimming = true, color_xy = true }\n\n[[controls]]",
    );
    let exceeds_member = replace(
        &exceeds_member,
        "single_transition_attribute = true\ncapabilities = { on_off = true, dimming = true, color_xy = true }",
        "single_transition_attribute = false\ncapabilities = { on_off = true, dimming = true, color_xy = true }",
    );
    assert!(reject(&exceeds_member).contains("every member"));

    let no_cct = replace(
        EXAMPLE,
        "capabilities = { on_off = true, dimming = true, color_temperature = { minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454 } }\n\n[[controls]]",
        "capabilities = { on_off = true, dimming = true }\n\n[[controls]]",
    );
    let no_cct = replace(
        &no_cct,
        "single_transition_attribute = true\ncapabilities = { on_off = true, dimming = true }",
        "single_transition_attribute = false\ncapabilities = { on_off = true, dimming = true }",
    );
    ValidatedConfig::parse(&no_cct).expect("non-CCT group needs no mired bounds");

    let missing_mired = replace(
        EXAMPLE,
        "minimum_mired = 250, maximum_mired = 454 } }\n\n[[controls]]",
        "maximum_mired = 454 } }\n\n[[controls]]",
    );
    assert!(reject(&missing_mired).contains("schema"));

    let wider_than_members = replace(
        EXAMPLE,
        "minimum_kelvin = 2200, maximum_kelvin = 4000, minimum_mired = 250, maximum_mired = 454 } }\n\n[[controls]]",
        "minimum_kelvin = 1500, maximum_kelvin = 8000, minimum_mired = 100, maximum_mired = 600 } }\n\n[[controls]]",
    );
    assert!(
        reject(&wider_than_members).contains("every member"),
        "group command range must fit every member"
    );
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
