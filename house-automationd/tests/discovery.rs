use std::collections::{BTreeMap, BTreeSet};

use house_automation_core::{
    reconcile::DeviceId,
    state::{ScopeId, ScopeMembership},
    value::Capabilities,
};
use house_automationd::{
    discovery::{
        BridgeDevice, DiscoveryError, Disposition, MAX_BRIDGE_DEVICES_BYTES, PlacementNote,
        StaticTopology, UncontrolledReason, classify, derive_light, kelvin_range_inside,
        parse_bridge_devices, placement,
    },
    zigbee2mqtt::{DeviceBinding, MiredRange},
};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("fixtures/bridge-devices.json");
const BULB: &str = "0x7cc6b6fffe3cef1c";
const REMOTE: &str = "0x000d6ffffea1b2c3";

fn scope(value: &str) -> ScopeId {
    ScopeId::new(value).unwrap()
}

fn bulb_id() -> DeviceId {
    DeviceId::new(BULB).unwrap()
}

fn devices_named(bulb_name: &str) -> Vec<BridgeDevice> {
    let original = format!("\"friendly_name\": \"{BULB}\"");
    assert_eq!(FIXTURE.matches(&original).count(), 1, "fixture drift");
    let renamed = FIXTURE.replace(&original, &format!("\"friendly_name\": \"{bulb_name}\""));
    parse_bridge_devices(renamed.as_bytes()).unwrap()
}

fn on_off_only() -> Capabilities {
    Capabilities {
        on_off: true,
        dimming: false,
        color_temperature: None,
        color_xy: false,
        color_hs: false,
        input: false,
        occupancy: false,
        temperature: false,
        power_metering: false,
    }
}

#[test]
fn derived_kelvin_range_is_inside_every_reported_mired_range() {
    let mut checked = 0;
    for minimum in (50_u16..=1000).step_by(7) {
        for maximum in (minimum..=1000).step_by(13) {
            let mired = MiredRange::new(minimum, maximum).unwrap();
            let Some(kelvin) = kelvin_range_inside(mired) else {
                continue;
            };
            assert!(
                1_000_000.0 / kelvin.max().get() >= f64::from(minimum),
                "{mired:?} -> {kelvin:?}"
            );
            assert!(
                1_000_000.0 / kelvin.min().get() <= f64::from(maximum),
                "{mired:?} -> {kelvin:?}"
            );
            checked += 1;
        }
    }
    assert!(checked > 1_000);

    for device in devices_named(BULB) {
        let Some(definition) = device.definition.as_ref() else {
            continue;
        };
        let Ok(Some(light)) = derive_light(definition) else {
            continue;
        };
        if let (Some(kelvin), Some(mired)) =
            (light.capabilities.color_temperature, light.mired_range)
        {
            assert!(1_000_000.0 / kelvin.max().get() >= f64::from(mired.min()));
            assert!(1_000_000.0 / kelvin.min().get() <= f64::from(mired.max()));
        }
    }
}

#[test]
fn led2111g6_interview_maps_to_a_dimmable_tunable_ikea_light() {
    let devices = devices_named(BULB);
    let bulb = devices
        .iter()
        .find(|device| device.ieee_address == BULB)
        .unwrap();
    let light = derive_light(bulb.definition.as_ref().unwrap())
        .unwrap()
        .unwrap();

    assert!(light.capabilities.on_off && light.capabilities.dimming);
    assert!(light.capabilities.color_xy && light.capabilities.color_hs);
    assert_eq!(light.mired_range, Some(MiredRange::new(250, 454).unwrap()));
    assert!(light.single_transition_attribute);
}

#[test]
fn every_accepted_placement_is_a_usable_topic_and_names_its_room() {
    for name in [
        "upper-floor/upper-hallway/lamp",
        "a/b/c",
        "ground_floor/kitchen-2/ceiling_1",
        BULB,
        "Upper/hall/lamp",
        "a/b",
        "a/b/c/d",
        "a//c",
        "a/b/set",
        "a/b/availability",
        "a/b/42",
        "a/b/-lamp",
        "a/b/lamp ",
    ] {
        if let Some(place) = placement(name) {
            let mut segments = name.split('/');
            assert_eq!(segments.next(), Some(place.floor.as_str()));
            assert_eq!(segments.next(), Some(place.room.as_str()));
            assert!(
                DeviceBinding::new(
                    DeviceId::new("probe").unwrap(),
                    name,
                    on_off_only(),
                    None,
                    false
                )
                .is_ok(),
                "{name} is placed but cannot be an MQTT topic"
            );
        }
    }
    assert!(placement("upper-floor/upper-hallway/lamp").is_some());
    for rejected in [BULB, "Upper/hall/lamp", "a/b/c/d", "a/b/set", "a/b/42"] {
        assert!(placement(rejected).is_none(), "{rejected}");
    }
}

#[test]
fn every_mappable_light_is_controlled_whatever_its_name() {
    let (names, ids, rooms) = (BTreeSet::new(), BTreeSet::new(), BTreeMap::new());
    let topology = StaticTopology {
        friendly_names: &names,
        device_ids: &ids,
        declared_rooms: &rooms,
    };
    for bulb_name in [
        BULB,
        "upper-floor/upper-hallway/lamp",
        "Kitchen lamp",
        "a/b/c/d",
    ] {
        let discovered = classify(&devices_named(bulb_name), &topology);
        assert!(
            matches!(
                discovered[&bulb_id()].disposition,
                Disposition::Controlled(_)
            ),
            "{bulb_name}: {:?}",
            discovered[&bulb_id()].disposition
        );
    }
    let placed = classify(&devices_named("upper-floor/upper-hallway/lamp"), &topology);
    assert_eq!(
        placed[&bulb_id()].membership,
        Some(ScopeMembership::new(
            scope("upper-hallway"),
            scope("upper-floor")
        ))
    );
    assert_eq!(
        classify(&devices_named(BULB), &topology)[&bulb_id()].membership,
        None
    );
}

#[test]
fn non_lights_are_listed_but_not_controlled_and_the_coordinator_is_not_listed() {
    let (names, ids, rooms) = (BTreeSet::new(), BTreeSet::new(), BTreeMap::new());
    let topology = StaticTopology {
        friendly_names: &names,
        device_ids: &ids,
        declared_rooms: &rooms,
    };
    let discovered = classify(&devices_named(BULB), &topology);

    assert_eq!(discovered.len(), 2);
    assert_eq!(
        discovered[&DeviceId::new(REMOTE).unwrap()].disposition,
        Disposition::NotControlled(UncontrolledReason::NotALight)
    );
}

#[test]
fn a_static_declaration_wins_and_a_declared_room_keeps_its_floor() {
    let names = BTreeSet::from(["demo/living-room/reading-light".to_owned()]);
    let (no_names, ids) = (BTreeSet::new(), BTreeSet::new());
    let rooms = BTreeMap::from([(scope("upper-hallway"), scope("upper-floor"))]);

    let shadowed = classify(
        &devices_named("demo/living-room/reading-light"),
        &StaticTopology {
            friendly_names: &names,
            device_ids: &ids,
            declared_rooms: &rooms,
        },
    );
    assert_eq!(
        shadowed[&bulb_id()].disposition,
        Disposition::NotControlled(UncontrolledReason::DeclaredStatically)
    );

    let elsewhere = classify(
        &devices_named("ground-floor/upper-hallway/lamp"),
        &StaticTopology {
            friendly_names: &no_names,
            device_ids: &ids,
            declared_rooms: &rooms,
        },
    );
    let bulb = &elsewhere[&bulb_id()];
    assert!(matches!(bulb.disposition, Disposition::Controlled(_)));
    assert_eq!(bulb.membership, None);
    assert_eq!(bulb.note, Some(PlacementNote::RoomDeclaredOnAnotherFloor));
}

#[test]
fn a_generic_light_is_controlled_but_an_undefined_disabled_or_half_interviewed_one_is_not() {
    let (names, ids, rooms) = (BTreeSet::new(), BTreeSet::new(), BTreeMap::new());
    let topology = StaticTopology {
        friendly_names: &names,
        device_ids: &ids,
        declared_rooms: &rooms,
    };
    let bulb_with = |change: &dyn Fn(&mut Value)| {
        let mut entries: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
        let bulb = entries
            .iter_mut()
            .find(|entry| entry["ieee_address"] == BULB)
            .unwrap();
        change(bulb);
        let devices = parse_bridge_devices(&serde_json::to_vec(&entries).unwrap()).unwrap();
        classify(&devices, &topology)[&bulb_id()].disposition.clone()
    };

    // Zigbee2MQTT reports `supported: false` for definitions it generated
    // from standard clusters; the exposes are still usable.
    assert!(matches!(
        bulb_with(&|bulb| {
            bulb["supported"] = json!(false);
            bulb["definition"]["source"] = json!("generated");
        }),
        Disposition::Controlled(_)
    ));
    assert_eq!(
        bulb_with(&|bulb| {
            bulb["supported"] = json!(false);
            bulb["definition"] = Value::Null;
        }),
        Disposition::NotControlled(UncontrolledReason::Unsupported)
    );
    assert_eq!(
        bulb_with(&|bulb| bulb["disabled"] = json!(true)),
        Disposition::NotControlled(UncontrolledReason::Disabled)
    );
    assert_eq!(
        bulb_with(&|bulb| bulb["interview_completed"] = json!(false)),
        Disposition::NotControlled(UncontrolledReason::InterviewIncomplete)
    );
}

#[test]
fn a_light_without_writable_state_is_not_controlled_and_says_why() {
    let mut devices = devices_named(BULB);
    let bulb = devices
        .iter_mut()
        .find(|device| device.ieee_address == BULB)
        .unwrap();
    let definition = bulb.definition.as_mut().unwrap();
    definition.exposes[0]["features"]
        .as_array_mut()
        .unwrap()
        .retain(|feature| feature["name"] != "state");

    assert_eq!(
        derive_light(definition),
        Err(UncontrolledReason::NoWritableState)
    );
}

#[test]
fn a_malformed_entry_does_not_hide_the_rest_but_a_malformed_list_is_rejected() {
    let mut entries: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    entries.push(json!({ "type": "Router" }));

    assert_eq!(
        parse_bridge_devices(&serde_json::to_vec(&entries).unwrap())
            .unwrap()
            .len(),
        3
    );
    assert_eq!(parse_bridge_devices(b"{}"), Err(DiscoveryError::Malformed));
    assert_eq!(
        parse_bridge_devices(&vec![b' '; MAX_BRIDGE_DEVICES_BYTES + 1]),
        Err(DiscoveryError::TooLarge)
    );
}
