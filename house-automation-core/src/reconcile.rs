use std::{
    collections::{BTreeMap, BTreeSet, btree_map},
    error::Error,
    fmt::{self, Display},
};

use serde::{Deserialize, Serialize};

use crate::value::{Capabilities, DeviceTarget, LightTarget};

const MAX_IDENTIFIER_LENGTH: usize = 64;

macro_rules! internal_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ReconcileError> {
                validate_identifier(value.into()).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = ReconcileError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

internal_id!(DeviceId);
internal_id!(EntityId);

fn validate_identifier(value: String) -> Result<String, ReconcileError> {
    let bytes = value.as_bytes();
    let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let valid_inner = |byte: u8| valid_edge(byte) || matches!(byte, b'_' | b'-');
    if bytes.is_empty()
        || bytes.len() > MAX_IDENTIFIER_LENGTH
        || !valid_edge(bytes[0])
        || !valid_edge(bytes[bytes.len() - 1])
        || !bytes.iter().copied().all(valid_inner)
    {
        return Err(ReconcileError::InvalidIdentifier);
    }
    Ok(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Unknown,
    Online,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportStatus {
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceDefinition {
    id: DeviceId,
    capabilities: Capabilities,
}

impl DeviceDefinition {
    pub fn new(id: DeviceId, capabilities: Capabilities) -> Self {
        Self { id, capabilities }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GroupDefinition {
    id: EntityId,
    members: Vec<DeviceId>,
    capabilities: Capabilities,
}

impl GroupDefinition {
    pub fn new(
        id: EntityId,
        members: Vec<DeviceId>,
        capabilities: Capabilities,
    ) -> Result<Self, ReconcileError> {
        if members.is_empty() {
            return Err(ReconcileError::EmptyGroup(id));
        }
        let unique: BTreeSet<_> = members.iter().cloned().collect();
        if unique.len() != members.len() {
            return Err(ReconcileError::DuplicateGroupMember);
        }
        let mut members: Vec<_> = unique.into_iter().collect();
        members.sort();
        Ok(Self {
            id,
            members,
            capabilities,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CommandEntity {
    Device(DeviceId),
    Group(EntityId),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReconcileAction {
    Resubscribe,
    RequestState(DeviceId),
    Command {
        entity: CommandEntity,
        target: DeviceTarget,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceState {
    capabilities: Capabilities,
    availability: Availability,
    desired: Option<DeviceTarget>,
    observed: Option<DeviceTarget>,
    last_command: Option<DeviceTarget>,
    in_sync: bool,
}

impl DeviceState {
    fn new(capabilities: Capabilities) -> Self {
        Self {
            capabilities,
            availability: Availability::Unknown,
            desired: None,
            observed: None,
            last_command: None,
            in_sync: true,
        }
    }

    pub fn availability(&self) -> Availability {
        self.availability
    }

    pub fn desired(&self) -> Option<DeviceTarget> {
        self.desired
    }

    pub fn observed(&self) -> Option<DeviceTarget> {
        self.observed
    }

    pub fn last_command(&self) -> Option<DeviceTarget> {
        self.last_command
    }

    pub fn in_sync(&self) -> bool {
        self.in_sync
    }
}

#[derive(Debug, Clone, PartialEq)]
struct GroupState {
    definition: GroupDefinition,
    desired: Option<DeviceTarget>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reconciler {
    devices: BTreeMap<DeviceId, DeviceState>,
    groups: BTreeMap<EntityId, GroupState>,
    transport: TransportStatus,
    bridge: Availability,
}

impl Reconciler {
    pub fn new(
        devices: Vec<DeviceDefinition>,
        groups: Vec<GroupDefinition>,
    ) -> Result<Self, ReconcileError> {
        let mut device_states = BTreeMap::new();
        for definition in devices {
            match device_states.entry(definition.id) {
                btree_map::Entry::Vacant(slot) => {
                    slot.insert(DeviceState::new(definition.capabilities));
                }
                btree_map::Entry::Occupied(slot) => {
                    return Err(ReconcileError::DuplicateDevice(slot.key().clone()));
                }
            }
        }

        let mut group_states = BTreeMap::new();
        let mut device_groups = BTreeMap::new();
        for definition in groups {
            for member in &definition.members {
                if !device_states.contains_key(member) {
                    return Err(ReconcileError::UnknownDevice(member.clone()));
                }
                if device_groups
                    .insert(member.clone(), definition.id.clone())
                    .is_some()
                {
                    return Err(ReconcileError::DeviceInMultipleGroups(member.clone()));
                }
            }
            let id = definition.id.clone();
            if group_states
                .insert(
                    id.clone(),
                    GroupState {
                        definition,
                        desired: None,
                    },
                )
                .is_some()
            {
                return Err(ReconcileError::DuplicateGroup(id));
            }
        }

        Ok(Self {
            devices: device_states,
            groups: group_states,
            transport: TransportStatus::Disconnected,
            bridge: Availability::Unknown,
        })
    }

    pub fn transport_status(&self) -> TransportStatus {
        self.transport
    }

    pub fn bridge_availability(&self) -> Availability {
        self.bridge
    }

    pub fn device_state(&self, id: &DeviceId) -> Result<&DeviceState, ReconcileError> {
        self.devices
            .get(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))
    }

    pub fn broker_disconnected(&mut self) {
        self.transport = TransportStatus::Disconnected;
    }

    pub fn broker_connected(&mut self) -> Vec<ReconcileAction> {
        self.transport = TransportStatus::Connected;
        let mut actions = vec![ReconcileAction::Resubscribe];
        actions.extend(
            self.devices
                .keys()
                .cloned()
                .map(ReconcileAction::RequestState),
        );
        actions.extend(self.reconcile_all());
        actions
    }

    pub fn set_bridge_availability(&mut self, availability: Availability) -> Vec<ReconcileAction> {
        let previous = self.bridge;
        self.bridge = availability;
        if previous == Availability::Offline && availability != Availability::Offline {
            self.reconcile_all()
        } else {
            Vec::new()
        }
    }

    pub fn set_device_availability(
        &mut self,
        id: &DeviceId,
        availability: Availability,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        let state = self
            .devices
            .get_mut(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
        let previous = state.availability;
        state.availability = availability;
        if previous == Availability::Offline && availability != Availability::Offline {
            Ok(self.command_device(id, true).into_iter().collect())
        } else {
            Ok(Vec::new())
        }
    }

    pub fn set_device_desired(
        &mut self,
        id: &DeviceId,
        target: LightTarget,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        let state = self
            .devices
            .get_mut(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
        let desired = state.capabilities.degrade(&target);
        if state.desired == Some(desired) {
            return Ok(Vec::new());
        }
        state.desired = Some(desired);
        state.in_sync = targets_in_sync(state.desired, state.observed);
        Ok(self.command_device(id, true).into_iter().collect())
    }

    pub fn set_group_desired(
        &mut self,
        id: &EntityId,
        target: LightTarget,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        let (members, group_target, changed) = {
            let group = self
                .groups
                .get_mut(id)
                .ok_or_else(|| ReconcileError::UnknownGroup(id.clone()))?;
            let group_target = group.definition.capabilities.degrade(&target);
            let changed = group.desired != Some(group_target);
            if changed {
                group.desired = Some(group_target);
            }
            (group.definition.members.clone(), group_target, changed)
        };
        if !changed {
            return Ok(Vec::new());
        }

        for member in &members {
            let state = self
                .devices
                .get_mut(member)
                .expect("group members validated when reconciler is constructed");
            let member_target = state.capabilities.degrade(&target);
            state.desired = Some(member_target);
            state.in_sync = targets_in_sync(state.desired, state.observed);
        }

        if !self.can_publish()
            || !members.iter().any(|member| {
                self.devices
                    .get(member)
                    .is_some_and(|state| state.availability != Availability::Offline)
            })
        {
            return Ok(Vec::new());
        }
        self.mark_group_commanded(&members);
        Ok(vec![ReconcileAction::Command {
            entity: CommandEntity::Group(id.clone()),
            target: group_target,
        }])
    }

    pub fn observe(
        &mut self,
        id: &DeviceId,
        observed: DeviceTarget,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        let state = self
            .devices
            .get_mut(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
        state.observed = Some(observed);
        state.in_sync = targets_in_sync(state.desired, state.observed);
        Ok(Vec::new())
    }

    pub fn device_restarted(
        &mut self,
        id: &DeviceId,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        let state = self
            .devices
            .get_mut(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
        state.observed = None;
        state.in_sync = state.desired.is_none();
        if self.transport != TransportStatus::Connected {
            return Ok(Vec::new());
        }
        let mut actions = vec![ReconcileAction::RequestState(id.clone())];
        actions.extend(self.command_device(id, true));
        Ok(actions)
    }

    fn can_publish(&self) -> bool {
        self.transport == TransportStatus::Connected && self.bridge != Availability::Offline
    }

    fn command_device(&mut self, id: &DeviceId, force: bool) -> Option<ReconcileAction> {
        if !self.can_publish() {
            return None;
        }
        let state = self.devices.get_mut(id)?;
        if state.availability == Availability::Offline {
            return None;
        }
        let desired = state.desired?;
        if !force && state.last_command == Some(desired) {
            return None;
        }
        state.last_command = Some(desired);
        state.in_sync = targets_in_sync(state.desired, state.observed);
        Some(ReconcileAction::Command {
            entity: CommandEntity::Device(id.clone()),
            target: desired,
        })
    }

    fn mark_group_commanded(&mut self, members: &[DeviceId]) {
        for member in members {
            let state = self
                .devices
                .get_mut(member)
                .expect("group members validated when reconciler is constructed");
            if state.availability != Availability::Offline {
                state.last_command = state.desired;
                state.in_sync = targets_in_sync(state.desired, state.observed);
            }
        }
    }

    fn reconcile_all(&mut self) -> Vec<ReconcileAction> {
        if !self.can_publish() {
            return Vec::new();
        }

        let groups: Vec<_> = self
            .groups
            .iter()
            .filter_map(|(id, state)| {
                state
                    .desired
                    .map(|target| (id.clone(), state.definition.members.clone(), target))
            })
            .collect();
        let mut actions = Vec::new();
        let mut grouped = BTreeSet::new();
        for (id, members, target) in groups {
            grouped.extend(members.iter().cloned());
            if members.iter().any(|member| {
                self.devices
                    .get(member)
                    .is_some_and(|state| state.availability != Availability::Offline)
            }) {
                self.mark_group_commanded(&members);
                actions.push(ReconcileAction::Command {
                    entity: CommandEntity::Group(id),
                    target,
                });
            }
        }

        let ungrouped: Vec<_> = self
            .devices
            .keys()
            .filter(|id| !grouped.contains(*id))
            .cloned()
            .collect();
        for id in ungrouped {
            actions.extend(self.command_device(&id, true));
        }
        actions
    }
}

fn targets_in_sync(desired: Option<DeviceTarget>, observed: Option<DeviceTarget>) -> bool {
    let Some(desired) = desired else {
        return true;
    };
    let Some(observed) = observed else {
        return false;
    };
    desired.on.is_none_or(|value| observed.on == Some(value))
        && desired
            .brightness
            .is_none_or(|value| observed.brightness == Some(value))
        && desired
            .color_temperature
            .is_none_or(|value| observed.color_temperature == Some(value))
        && desired
            .color
            .is_none_or(|value| observed.color == Some(value))
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReconcileError {
    InvalidIdentifier,
    DuplicateDevice(DeviceId),
    UnknownDevice(DeviceId),
    DuplicateGroup(EntityId),
    UnknownGroup(EntityId),
    EmptyGroup(EntityId),
    DuplicateGroupMember,
    DeviceInMultipleGroups(DeviceId),
}

impl Display for ReconcileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier => formatter.write_str(
                "identifier must be 1-64 lowercase ASCII letters, digits, hyphens, or underscores and start and end with a letter or digit",
            ),
            Self::DuplicateDevice(id) => write!(formatter, "duplicate device {}", id.as_str()),
            Self::UnknownDevice(id) => write!(formatter, "unknown device {}", id.as_str()),
            Self::DuplicateGroup(id) => write!(formatter, "duplicate group {}", id.as_str()),
            Self::UnknownGroup(id) => write!(formatter, "unknown group {}", id.as_str()),
            Self::EmptyGroup(id) => write!(formatter, "group {} has no members", id.as_str()),
            Self::DuplicateGroupMember => formatter.write_str("group contains duplicate member"),
            Self::DeviceInMultipleGroups(id) => {
                write!(formatter, "device {} belongs to multiple command groups", id.as_str())
            }
        }
    }
}

impl Error for ReconcileError {}

#[cfg(test)]
mod tests {
    use crate::value::{Brightness, Capabilities, DeviceTarget, Kelvin, KelvinRange, LightTarget};

    use super::{
        Availability, CommandEntity, DeviceDefinition, DeviceId, EntityId, GroupDefinition,
        ReconcileAction, Reconciler, TransportStatus,
    };

    fn id(value: &str) -> DeviceId {
        DeviceId::new(value).unwrap()
    }

    fn entity(value: &str) -> EntityId {
        EntityId::new(value).unwrap()
    }

    fn capabilities() -> Capabilities {
        Capabilities {
            on_off: true,
            dimming: true,
            color_temperature: Some(KelvinRange::new(2200.0, 4000.0).unwrap()),
            color_xy: false,
            color_hs: false,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        }
    }

    fn target(brightness: f64) -> LightTarget {
        LightTarget {
            on: true,
            brightness: Some(Brightness::new(brightness).unwrap()),
            color_temperature: Some(Kelvin::new(2700.0).unwrap()),
            color: None,
            transition_ms: Some(500),
        }
    }

    fn device_target(brightness: f64) -> DeviceTarget {
        capabilities().degrade(&target(brightness))
    }

    fn connected_reconciler(devices: Vec<DeviceDefinition>) -> Reconciler {
        let mut reconciler = Reconciler::new(devices, Vec::new()).unwrap();
        let _ = reconciler.broker_connected();
        reconciler
    }

    #[test]
    fn internal_identifiers_reject_external_topic_names() {
        for invalid in ["", "Kitchen", "kitchen/lamp", "-lamp", "lamp-"] {
            assert!(
                DeviceId::new(invalid).is_err(),
                "accepted device ID {invalid:?}"
            );
            assert!(
                EntityId::new(invalid).is_err(),
                "accepted entity ID {invalid:?}"
            );
        }
        assert_eq!(id("kitchen-lamp_1").as_str(), "kitchen-lamp_1");
        assert_eq!(entity("downstairs_lights").as_str(), "downstairs_lights");
    }

    #[test]
    fn desired_change_publishes_once_and_observation_does_not_oscillate() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);

        assert_eq!(
            reconciler.set_device_desired(&lamp, target(0.5)).unwrap(),
            vec![ReconcileAction::Command {
                entity: CommandEntity::Device(lamp.clone()),
                target: device_target(0.5),
            }]
        );
        assert!(
            reconciler
                .observe(&lamp, device_target(0.2))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .observe(&lamp, device_target(0.2))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.5))
                .unwrap()
                .is_empty()
        );
        assert!(!reconciler.device_state(&lamp).unwrap().in_sync());

        assert!(
            reconciler
                .observe(&lamp, device_target(0.5))
                .unwrap()
                .is_empty()
        );
        assert!(reconciler.device_state(&lamp).unwrap().in_sync());
    }

    #[test]
    fn offline_suppresses_commands_and_online_reconciles_latest_desired() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        assert!(
            reconciler
                .set_device_availability(&lamp, Availability::Offline)
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.3))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reconciler
                .set_device_availability(&lamp, Availability::Online)
                .unwrap(),
            vec![ReconcileAction::Command {
                entity: CommandEntity::Device(lamp),
                target: device_target(0.3),
            }]
        );
    }

    #[test]
    fn disabling_availability_after_offline_reconciles_as_unknown() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler
            .set_device_availability(&lamp, Availability::Offline)
            .unwrap();
        reconciler.set_device_desired(&lamp, target(0.3)).unwrap();

        assert_eq!(
            reconciler
                .set_device_availability(&lamp, Availability::Unknown)
                .unwrap(),
            vec![ReconcileAction::Command {
                entity: CommandEntity::Device(lamp),
                target: device_target(0.3),
            }]
        );
    }

    #[test]
    fn unknown_availability_does_not_block_commands() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        assert_eq!(
            reconciler.device_state(&lamp).unwrap().availability(),
            Availability::Unknown
        );
        assert_eq!(
            reconciler
                .set_device_desired(&lamp, target(0.4))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn observed_state_matches_desired_without_echoing_transition_metadata() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler.set_device_desired(&lamp, target(0.5)).unwrap();
        let mut observed = device_target(0.5);
        observed.transition_ms = None;

        reconciler.observe(&lamp, observed).unwrap();

        assert!(reconciler.device_state(&lamp).unwrap().in_sync());
    }

    #[test]
    fn group_command_records_member_desires_without_immediate_fanout() {
        let left = id("left");
        let right = id("right");
        let group = entity("living_room");
        let definition = GroupDefinition::new(
            group.clone(),
            vec![right.clone(), left.clone()],
            capabilities(),
        )
        .unwrap();
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(left.clone(), capabilities()),
                DeviceDefinition::new(right.clone(), capabilities()),
            ],
            vec![definition],
        )
        .unwrap();
        let _ = reconciler.broker_connected();

        assert_eq!(
            reconciler.set_group_desired(&group, target(0.6)).unwrap(),
            vec![ReconcileAction::Command {
                entity: CommandEntity::Group(group),
                target: device_target(0.6),
            }]
        );
        assert_eq!(
            reconciler.device_state(&left).unwrap().desired(),
            Some(device_target(0.6))
        );
        assert_eq!(
            reconciler.device_state(&right).unwrap().desired(),
            Some(device_target(0.6))
        );
    }

    #[test]
    fn offline_group_member_gets_per_device_fallback_on_recovery() {
        let left = id("left");
        let right = id("right");
        let group = entity("living_room");
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(left.clone(), capabilities()),
                DeviceDefinition::new(right.clone(), capabilities()),
            ],
            vec![
                GroupDefinition::new(group.clone(), vec![left.clone(), right], capabilities())
                    .unwrap(),
            ],
        )
        .unwrap();
        let _ = reconciler.broker_connected();
        reconciler
            .set_device_availability(&left, Availability::Offline)
            .unwrap();
        assert_eq!(
            reconciler
                .set_group_desired(&group, target(0.7))
                .unwrap()
                .len(),
            1
        );

        assert_eq!(
            reconciler
                .set_device_availability(&left, Availability::Online)
                .unwrap(),
            vec![ReconcileAction::Command {
                entity: CommandEntity::Device(left),
                target: device_target(0.7),
            }]
        );
    }

    #[test]
    fn broker_reconnect_resubscribes_requests_state_and_forces_deterministic_reconcile() {
        let lamp_b = id("lamp_b");
        let lamp_a = id("lamp_a");
        let mut reconciler = connected_reconciler(vec![
            DeviceDefinition::new(lamp_b.clone(), capabilities()),
            DeviceDefinition::new(lamp_a.clone(), capabilities()),
        ]);
        let _ = reconciler.set_device_desired(&lamp_b, target(0.8)).unwrap();
        let _ = reconciler.set_device_desired(&lamp_a, target(0.2)).unwrap();
        reconciler.broker_disconnected();
        assert_eq!(reconciler.transport_status(), TransportStatus::Disconnected);

        assert_eq!(
            reconciler.broker_connected(),
            vec![
                ReconcileAction::Resubscribe,
                ReconcileAction::RequestState(lamp_a.clone()),
                ReconcileAction::RequestState(lamp_b.clone()),
                ReconcileAction::Command {
                    entity: CommandEntity::Device(lamp_a),
                    target: device_target(0.2),
                },
                ReconcileAction::Command {
                    entity: CommandEntity::Device(lamp_b),
                    target: device_target(0.8),
                },
            ]
        );
    }

    #[test]
    fn bridge_recovery_reconciles_group_first_then_ungrouped_devices() {
        let grouped = id("grouped");
        let ungrouped = id("ungrouped");
        let group = entity("group");
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(grouped.clone(), capabilities()),
                DeviceDefinition::new(ungrouped.clone(), capabilities()),
            ],
            vec![GroupDefinition::new(group.clone(), vec![grouped], capabilities()).unwrap()],
        )
        .unwrap();
        let _ = reconciler.broker_connected();
        let _ = reconciler.set_group_desired(&group, target(0.7)).unwrap();
        let _ = reconciler
            .set_device_desired(&ungrouped, target(0.3))
            .unwrap();
        reconciler.set_bridge_availability(Availability::Offline);
        assert!(
            reconciler
                .set_group_desired(&group, target(0.8))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_desired(&ungrouped, target(0.4))
                .unwrap()
                .is_empty()
        );

        assert_eq!(
            reconciler.set_bridge_availability(Availability::Online),
            vec![
                ReconcileAction::Command {
                    entity: CommandEntity::Group(group),
                    target: device_target(0.8),
                },
                ReconcileAction::Command {
                    entity: CommandEntity::Device(ungrouped),
                    target: device_target(0.4),
                },
            ]
        );
    }

    #[test]
    fn initial_bridge_online_report_does_not_duplicate_unknown_allowed_command() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        assert_eq!(
            reconciler
                .set_device_desired(&lamp, target(0.5))
                .unwrap()
                .len(),
            1
        );

        assert!(
            reconciler
                .set_bridge_availability(Availability::Online)
                .is_empty()
        );
    }

    #[test]
    fn restart_reacquires_state_and_reconciles_without_waiting_for_mismatch() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let _ = reconciler.set_device_desired(&lamp, target(0.5)).unwrap();
        let _ = reconciler.observe(&lamp, device_target(0.5)).unwrap();

        assert_eq!(
            reconciler.device_restarted(&lamp).unwrap(),
            vec![
                ReconcileAction::RequestState(lamp.clone()),
                ReconcileAction::Command {
                    entity: CommandEntity::Device(lamp),
                    target: device_target(0.5),
                },
            ]
        );
    }
}
