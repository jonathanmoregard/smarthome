use std::{
    collections::{BTreeMap, BTreeSet, btree_map},
    error::Error,
    fmt::{self, Display},
};

use serde::{Deserialize, Serialize};

use crate::{
    state::MonotonicTime,
    value::{Capabilities, DeviceTarget, LightTarget},
};

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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RetryPolicy {
    interval_seconds: f64,
    max_attempts: u8,
}

impl RetryPolicy {
    pub fn new(interval_seconds: f64, max_attempts: u8) -> Result<Self, ReconcileError> {
        if !interval_seconds.is_finite() || interval_seconds <= 0.0 {
            return Err(ReconcileError::InvalidRetryInterval);
        }
        if !(1..=10).contains(&max_attempts) {
            return Err(ReconcileError::InvalidRetryAttempts);
        }
        Ok(Self {
            interval_seconds,
            max_attempts,
        })
    }

    fn deadline(self, now: MonotonicTime) -> Result<MonotonicTime, ReconcileError> {
        let seconds = now.seconds() + self.interval_seconds;
        if !seconds.is_finite() || seconds <= now.seconds() {
            return Err(ReconcileError::RetryDeadlineOverflow);
        }
        MonotonicTime::from_seconds(seconds).map_err(|_| ReconcileError::RetryDeadlineOverflow)
    }
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
    pending: Option<PendingCommand>,
    in_sync: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PendingCommand {
    target: DeviceTarget,
    deadline: MonotonicTime,
    attempts: u8,
}

impl PendingCommand {
    pub fn target(self) -> DeviceTarget {
        self.target
    }

    pub fn deadline(self) -> MonotonicTime {
        self.deadline
    }

    pub fn attempts(self) -> u8 {
        self.attempts
    }
}

impl DeviceState {
    fn new(capabilities: Capabilities) -> Self {
        Self {
            capabilities,
            availability: Availability::Unknown,
            desired: None,
            observed: None,
            last_command: None,
            pending: None,
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

    pub fn pending_command(&self) -> Option<PendingCommand> {
        self.pending
    }

    pub fn in_sync(&self) -> bool {
        self.in_sync
    }
}

#[derive(Debug, Clone, PartialEq)]
struct GroupState {
    definition: GroupDefinition,
    logical_desired: Option<LightTarget>,
    command_target: Option<DeviceTarget>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reconciler {
    devices: BTreeMap<DeviceId, DeviceState>,
    groups: BTreeMap<EntityId, GroupState>,
    transport: TransportStatus,
    bridge: Availability,
    retry_policy: RetryPolicy,
    last_time: Option<MonotonicTime>,
}

impl Reconciler {
    pub fn new(
        devices: Vec<DeviceDefinition>,
        groups: Vec<GroupDefinition>,
        retry_policy: RetryPolicy,
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
                        logical_desired: None,
                        command_target: None,
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
            retry_policy,
            last_time: None,
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

    pub fn broker_disconnected(&mut self, now: MonotonicTime) -> Result<(), ReconcileError> {
        self.transact(now, |next, _| {
            next.transport = TransportStatus::Disconnected;
            Ok(Vec::new())
        })?;
        Ok(())
    }

    pub fn broker_connected(
        &mut self,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            next.transport = TransportStatus::Connected;
            let mut actions = vec![ReconcileAction::Resubscribe];
            actions.extend(
                next.devices
                    .keys()
                    .cloned()
                    .map(ReconcileAction::RequestState),
            );
            actions.extend(next.reconcile_all(now)?);
            Ok(actions)
        })
    }

    pub fn set_bridge_availability(
        &mut self,
        availability: Availability,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            let previous = next.bridge;
            next.bridge = availability;
            if previous == Availability::Offline && availability != Availability::Offline {
                next.reconcile_all(now)
            } else {
                Ok(Vec::new())
            }
        })
    }

    pub fn set_device_availability(
        &mut self,
        id: &DeviceId,
        availability: Availability,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            let state = next
                .devices
                .get_mut(id)
                .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
            let previous = state.availability;
            state.availability = availability;
            if availability == Availability::Offline {
                state.pending = None;
            }
            if previous == Availability::Offline && availability != Availability::Offline {
                Ok(next.command_device(id, now)?.into_iter().collect())
            } else {
                Ok(Vec::new())
            }
        })
    }

    pub fn set_device_desired(
        &mut self,
        id: &DeviceId,
        target: LightTarget,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            let state = next
                .devices
                .get_mut(id)
                .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
            let desired = state.capabilities.degrade(&target);
            if state.desired == Some(desired) {
                return Ok(Vec::new());
            }
            state.desired = Some(desired);
            state.pending = None;
            state.in_sync = targets_in_sync(state.desired, state.observed);
            if state.in_sync {
                return Ok(Vec::new());
            }
            Ok(next.command_device(id, now)?.into_iter().collect())
        })
    }

    pub fn set_group_desired(
        &mut self,
        id: &EntityId,
        target: LightTarget,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            next.set_group_desired_inner(id, target, now)
        })
    }

    fn set_group_desired_inner(
        &mut self,
        id: &EntityId,
        target: LightTarget,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        let (members, group_target, group_target_changed) = {
            let group = self
                .groups
                .get_mut(id)
                .ok_or_else(|| ReconcileError::UnknownGroup(id.clone()))?;
            if group.logical_desired == Some(target) {
                return Ok(Vec::new());
            }
            let group_target = group.definition.capabilities.degrade(&target);
            let group_target_changed = group.command_target != Some(group_target);
            group.logical_desired = Some(target);
            group.command_target = Some(group_target);
            (
                group.definition.members.clone(),
                group_target,
                group_target_changed,
            )
        };

        let mut changed_members = BTreeSet::new();
        for member in &members {
            let state = self
                .devices
                .get_mut(member)
                .expect("group members validated when reconciler is constructed");
            let member_target = state.capabilities.degrade(&target);
            if state.desired != Some(member_target) {
                changed_members.insert(member.clone());
                state.desired = Some(member_target);
                state.pending = None;
                state.in_sync = targets_in_sync(state.desired, state.observed);
            }
        }

        self.command_group_with_fallbacks(
            id,
            &members,
            group_target,
            group_target_changed,
            &changed_members,
            now,
        )
    }

    pub fn observe(
        &mut self,
        id: &DeviceId,
        observed: DeviceTarget,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, _| {
            let state = next
                .devices
                .get_mut(id)
                .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
            state.observed = Some(merge_observation(state.observed, observed));
            state.in_sync = targets_in_sync(state.desired, state.observed);
            if state.in_sync {
                state.pending = None;
            }
            Ok(Vec::new())
        })
    }

    pub fn device_restarted(
        &mut self,
        id: &DeviceId,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            let state = next
                .devices
                .get_mut(id)
                .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
            state.observed = None;
            state.pending = None;
            state.in_sync = state.desired.is_none();
            if next.transport != TransportStatus::Connected {
                return Ok(Vec::new());
            }
            let mut actions = vec![ReconcileAction::RequestState(id.clone())];
            actions.extend(next.command_device(id, now)?);
            Ok(actions)
        })
    }

    pub fn retry_due(
        &mut self,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| next.retry_due_inner(now))
    }

    fn retry_due_inner(
        &mut self,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        if !self.can_publish() {
            return Ok(Vec::new());
        }
        let due: Vec<_> = self
            .devices
            .iter()
            .filter_map(|(id, state)| {
                state
                    .pending
                    .filter(|pending| now >= pending.deadline)
                    .map(|pending| (id.clone(), pending))
            })
            .collect();
        let mut actions = Vec::new();
        for (id, pending) in due {
            let state = self
                .devices
                .get(&id)
                .expect("due command came from configured device");
            if state.availability == Availability::Offline
                || pending.attempts >= self.retry_policy.max_attempts
            {
                continue;
            }
            let deadline = self.retry_policy.deadline(now)?;
            let state = self
                .devices
                .get_mut(&id)
                .expect("due command came from configured device");
            state.pending = Some(PendingCommand {
                target: pending.target,
                deadline,
                attempts: pending.attempts + 1,
            });
            state.last_command = Some(pending.target);
            state.in_sync = false;
            actions.push(ReconcileAction::Command {
                entity: CommandEntity::Device(id),
                target: pending.target,
            });
        }
        Ok(actions)
    }

    fn transact<F>(
        &mut self,
        now: MonotonicTime,
        operation: F,
    ) -> Result<Vec<ReconcileAction>, ReconcileError>
    where
        F: FnOnce(&mut Self, MonotonicTime) -> Result<Vec<ReconcileAction>, ReconcileError>,
    {
        if self.last_time.is_some_and(|previous| now < previous) {
            return Err(ReconcileError::MonotonicClockRegressed);
        }
        let mut next = self.clone();
        let actions = operation(&mut next, now)?;
        next.last_time = Some(now);
        *self = next;
        Ok(actions)
    }

    fn can_publish(&self) -> bool {
        self.transport == TransportStatus::Connected && self.bridge != Availability::Offline
    }

    fn command_device(
        &mut self,
        id: &DeviceId,
        now: MonotonicTime,
    ) -> Result<Option<ReconcileAction>, ReconcileError> {
        if !self.can_publish() {
            return Ok(None);
        }
        let state = self
            .devices
            .get(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
        if state.availability == Availability::Offline {
            return Ok(None);
        }
        let Some(desired) = state.desired else {
            return Ok(None);
        };
        self.record_command(id, desired, now)?;
        Ok(Some(ReconcileAction::Command {
            entity: CommandEntity::Device(id.clone()),
            target: desired,
        }))
    }

    fn record_command(
        &mut self,
        id: &DeviceId,
        combined_target: DeviceTarget,
        now: MonotonicTime,
    ) -> Result<(), ReconcileError> {
        let deadline = self.retry_policy.deadline(now)?;
        let state = self
            .devices
            .get_mut(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
        state.last_command = Some(combined_target);
        state.pending = Some(PendingCommand {
            target: combined_target,
            deadline,
            attempts: 1,
        });
        state.in_sync = targets_in_sync(state.desired, state.observed);
        if state.in_sync {
            state.pending = None;
        }
        Ok(())
    }

    fn command_group_with_fallbacks(
        &mut self,
        id: &EntityId,
        members: &[DeviceId],
        group_target: DeviceTarget,
        send_group: bool,
        changed_members: &BTreeSet<DeviceId>,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        if !self.can_publish() {
            return Ok(Vec::new());
        }
        let active: Vec<_> = members
            .iter()
            .filter(|member| {
                self.devices
                    .get(*member)
                    .is_some_and(|state| state.availability != Availability::Offline)
            })
            .cloned()
            .collect();
        if active.is_empty() {
            return Ok(Vec::new());
        }

        let group_has_fields = !target_is_empty(group_target);
        let group_sent = send_group && group_has_fields;
        let mut actions = Vec::new();
        if group_sent {
            actions.push(ReconcileAction::Command {
                entity: CommandEntity::Group(id.clone()),
                target: group_target,
            });
        }

        for member in active {
            let desired = self
                .devices
                .get(&member)
                .and_then(|state| state.desired)
                .expect("group desired state records every member target");
            let fallback = if group_has_fields {
                target_difference(desired, group_target)
            } else {
                desired
            };
            let fallback_sent =
                !target_is_empty(fallback) && (group_sent || changed_members.contains(&member));
            if fallback_sent {
                actions.push(ReconcileAction::Command {
                    entity: CommandEntity::Device(member.clone()),
                    target: fallback,
                });
            }
            if group_sent || fallback_sent {
                self.record_command(&member, desired, now)?;
            }
        }
        Ok(actions)
    }

    fn reconcile_all(
        &mut self,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        if !self.can_publish() {
            return Ok(Vec::new());
        }

        let groups: Vec<_> = self
            .groups
            .iter()
            .filter_map(|(id, state)| {
                state
                    .command_target
                    .map(|target| (id.clone(), state.definition.members.clone(), target))
            })
            .collect();
        let mut actions = Vec::new();
        let mut grouped = BTreeSet::new();
        for (id, members, target) in groups {
            grouped.extend(members.iter().cloned());
            let all_members: BTreeSet<_> = members.iter().cloned().collect();
            actions.extend(self.command_group_with_fallbacks(
                &id,
                &members,
                target,
                true,
                &all_members,
                now,
            )?);
        }

        let ungrouped: Vec<_> = self
            .devices
            .keys()
            .filter(|id| !grouped.contains(*id))
            .cloned()
            .collect();
        for id in ungrouped {
            actions.extend(self.command_device(&id, now)?);
        }
        Ok(actions)
    }
}

fn target_is_empty(target: DeviceTarget) -> bool {
    target.on.is_none()
        && target.brightness.is_none()
        && target.color_temperature.is_none()
        && target.color.is_none()
}

fn merge_observation(previous: Option<DeviceTarget>, update: DeviceTarget) -> DeviceTarget {
    let previous = previous.unwrap_or(DeviceTarget {
        on: None,
        brightness: None,
        color_temperature: None,
        color: None,
        transition_ms: None,
    });
    let (color_temperature, color) = if update.color.is_some() {
        (None, update.color)
    } else if update.color_temperature.is_some() {
        (update.color_temperature, None)
    } else {
        (previous.color_temperature, previous.color)
    };
    DeviceTarget {
        on: update.on.or(previous.on),
        brightness: update.brightness.or(previous.brightness),
        color_temperature,
        color,
        transition_ms: update.transition_ms.or(previous.transition_ms),
    }
}

fn target_difference(desired: DeviceTarget, group: DeviceTarget) -> DeviceTarget {
    let on = (desired.on != group.on).then_some(desired.on).flatten();
    let brightness = (desired.brightness != group.brightness)
        .then_some(desired.brightness)
        .flatten();
    let color_temperature = (desired.color_temperature != group.color_temperature)
        .then_some(desired.color_temperature)
        .flatten();
    let color = (desired.color != group.color)
        .then_some(desired.color)
        .flatten();
    let transition_ms = if brightness.is_some() || color_temperature.is_some() || color.is_some() {
        desired.transition_ms
    } else {
        None
    };
    DeviceTarget {
        on,
        brightness,
        color_temperature,
        color,
        transition_ms,
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
        && desired.brightness.is_none_or(|desired| {
            observed
                .brightness
                .is_some_and(|observed| (desired.get() - observed.get()).abs() <= 1.0 / 254.0)
        })
        && desired.color_temperature.is_none_or(|desired| {
            observed.color_temperature.is_some_and(|observed| {
                (desired.get() - observed.get()).abs() <= desired.get() * 0.01
            })
        })
        && desired.color.is_none_or(|desired| {
            observed
                .color
                .is_some_and(|observed| colors_in_sync(desired, observed))
        })
}

fn colors_in_sync(desired: crate::value::Color, observed: crate::value::Color) -> bool {
    match (desired.xy_components(), observed.xy_components()) {
        (Some((desired_x, desired_y)), Some((observed_x, observed_y))) => {
            (desired_x - observed_x).abs() <= 0.001 && (desired_y - observed_y).abs() <= 0.001
        }
        _ => match (desired.hs_components(), observed.hs_components()) {
            (
                Some((desired_hue, desired_saturation)),
                Some((observed_hue, observed_saturation)),
            ) => {
                let hue_difference = (desired_hue - observed_hue).abs();
                hue_difference.min(360.0 - hue_difference) <= 0.5
                    && (desired_saturation - observed_saturation).abs() <= 0.01
            }
            _ => false,
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReconcileError {
    InvalidIdentifier,
    InvalidRetryInterval,
    InvalidRetryAttempts,
    RetryDeadlineOverflow,
    MonotonicClockRegressed,
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
            Self::InvalidRetryInterval => {
                formatter.write_str("retry interval must be finite and greater than zero")
            }
            Self::InvalidRetryAttempts => {
                formatter.write_str("retry attempts must be between 1 and 10")
            }
            Self::RetryDeadlineOverflow => formatter.write_str("retry deadline exceeds monotonic range"),
            Self::MonotonicClockRegressed => formatter.write_str("monotonic clock regressed"),
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
    use crate::state::MonotonicTime;
    use crate::value::{
        Brightness, Capabilities, Color, DeviceTarget, Kelvin, KelvinRange, LightTarget,
    };

    use super::{
        Availability, CommandEntity, DeviceDefinition, DeviceId, EntityId, GroupDefinition,
        ReconcileAction, Reconciler, RetryPolicy, TransportStatus,
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
        let mut reconciler = Reconciler::new(devices, Vec::new(), retry_policy()).unwrap();
        let _ = reconciler.broker_connected(at(0.0)).unwrap();
        reconciler
    }

    fn at(seconds: f64) -> MonotonicTime {
        MonotonicTime::from_seconds(seconds).unwrap()
    }

    fn retry_policy() -> RetryPolicy {
        RetryPolicy::new(2.0, 3).unwrap()
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
            reconciler
                .set_device_desired(&lamp, target(0.5), at(1.0))
                .unwrap(),
            vec![ReconcileAction::Command {
                entity: CommandEntity::Device(lamp.clone()),
                target: device_target(0.5),
            }]
        );
        assert!(
            reconciler
                .observe(&lamp, device_target(0.2), at(1.1))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .observe(&lamp, device_target(0.2), at(1.2))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.5), at(1.3))
                .unwrap()
                .is_empty()
        );
        assert!(!reconciler.device_state(&lamp).unwrap().in_sync());

        assert!(
            reconciler
                .observe(&lamp, device_target(0.5), at(1.4))
                .unwrap()
                .is_empty()
        );
        assert!(reconciler.device_state(&lamp).unwrap().in_sync());
    }

    #[test]
    fn desired_change_already_satisfied_by_observation_does_not_publish() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler
            .observe(&lamp, device_target(0.5), at(1.0))
            .unwrap();

        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.5), at(1.1))
                .unwrap()
                .is_empty()
        );
        assert!(reconciler.device_state(&lamp).unwrap().in_sync());
        assert!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .is_none()
        );
        assert_eq!(reconciler.device_state(&lamp).unwrap().last_command(), None);
    }

    #[test]
    fn offline_suppresses_commands_and_online_reconciles_latest_desired() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        assert!(
            reconciler
                .set_device_availability(&lamp, Availability::Offline, at(1.0))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.3), at(1.1))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reconciler
                .set_device_availability(&lamp, Availability::Online, at(1.2))
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
            .set_device_availability(&lamp, Availability::Offline, at(1.0))
            .unwrap();
        reconciler
            .set_device_desired(&lamp, target(0.3), at(1.1))
            .unwrap();

        assert_eq!(
            reconciler
                .set_device_availability(&lamp, Availability::Unknown, at(1.2))
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
                .set_device_desired(&lamp, target(0.4), at(1.0))
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
        reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let mut observed = device_target(0.5);
        observed.transition_ms = None;

        reconciler.observe(&lamp, observed, at(1.1)).unwrap();

        assert!(reconciler.device_state(&lamp).unwrap().in_sync());
    }

    #[test]
    fn protocol_quantization_does_not_create_false_divergence() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler
            .set_device_desired(&lamp, target(0.6), at(1.0))
            .unwrap();
        let observed = DeviceTarget {
            on: Some(true),
            brightness: Some(Brightness::new(152.0 / 254.0).unwrap()),
            color_temperature: Some(Kelvin::new(1_000_000.0 / 370.0).unwrap()),
            color: None,
            transition_ms: None,
        };

        reconciler.observe(&lamp, observed, at(1.1)).unwrap();

        assert!(reconciler.device_state(&lamp).unwrap().in_sync());
        assert!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .is_none()
        );
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
            retry_policy(),
        )
        .unwrap();
        let _ = reconciler.broker_connected(at(0.0)).unwrap();

        assert_eq!(
            reconciler
                .set_group_desired(&group, target(0.6), at(1.0))
                .unwrap(),
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
            retry_policy(),
        )
        .unwrap();
        let _ = reconciler.broker_connected(at(0.0)).unwrap();
        reconciler
            .set_device_availability(&left, Availability::Offline, at(1.0))
            .unwrap();
        assert_eq!(
            reconciler
                .set_group_desired(&group, target(0.7), at(1.1))
                .unwrap()
                .len(),
            1
        );

        assert_eq!(
            reconciler
                .set_device_availability(&left, Availability::Online, at(1.2))
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
        let _ = reconciler
            .set_device_desired(&lamp_b, target(0.8), at(1.0))
            .unwrap();
        let _ = reconciler
            .set_device_desired(&lamp_a, target(0.2), at(1.1))
            .unwrap();
        reconciler.broker_disconnected(at(2.0)).unwrap();
        assert_eq!(reconciler.transport_status(), TransportStatus::Disconnected);

        assert_eq!(
            reconciler.broker_connected(at(3.0)).unwrap(),
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
            retry_policy(),
        )
        .unwrap();
        let _ = reconciler.broker_connected(at(0.0)).unwrap();
        let _ = reconciler
            .set_group_desired(&group, target(0.7), at(1.0))
            .unwrap();
        let _ = reconciler
            .set_device_desired(&ungrouped, target(0.3), at(1.1))
            .unwrap();
        reconciler
            .set_bridge_availability(Availability::Offline, at(1.2))
            .unwrap();
        assert!(
            reconciler
                .set_group_desired(&group, target(0.8), at(1.3))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_desired(&ungrouped, target(0.4), at(1.4))
                .unwrap()
                .is_empty()
        );

        assert_eq!(
            reconciler
                .set_bridge_availability(Availability::Online, at(1.5))
                .unwrap(),
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
                .set_device_desired(&lamp, target(0.5), at(1.0))
                .unwrap()
                .len(),
            1
        );

        assert!(
            reconciler
                .set_bridge_availability(Availability::Online, at(1.1))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn restart_reacquires_state_and_reconciles_without_waiting_for_mismatch() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let _ = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let _ = reconciler
            .observe(&lamp, device_target(0.5), at(1.1))
            .unwrap();

        assert_eq!(
            reconciler.device_restarted(&lamp, at(1.2)).unwrap(),
            vec![
                ReconcileAction::RequestState(lamp.clone()),
                ReconcileAction::Command {
                    entity: CommandEntity::Device(lamp),
                    target: device_target(0.5),
                },
            ]
        );
    }

    #[test]
    fn lost_command_retries_at_exact_deadline_then_stops_without_oscillation() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let expected = ReconcileAction::Command {
            entity: CommandEntity::Device(lamp.clone()),
            target: device_target(0.5),
        };
        assert_eq!(
            reconciler
                .set_device_desired(&lamp, target(0.5), at(1.0))
                .unwrap(),
            vec![expected.clone()]
        );
        let pending = reconciler
            .device_state(&lamp)
            .unwrap()
            .pending_command()
            .unwrap();
        assert_eq!(pending.attempts(), 1);
        assert_eq!(pending.deadline().seconds(), 3.0);

        assert!(reconciler.retry_due(at(2.999)).unwrap().is_empty());
        assert_eq!(
            reconciler.retry_due(at(3.0)).unwrap(),
            vec![expected.clone()]
        );
        assert_eq!(
            reconciler
                .observe(&lamp, device_target(0.2), at(3.1))
                .unwrap(),
            Vec::new()
        );
        assert_eq!(reconciler.retry_due(at(5.0)).unwrap(), vec![expected]);
        assert!(reconciler.retry_due(at(7.0)).unwrap().is_empty());
        let pending = reconciler
            .device_state(&lamp)
            .unwrap()
            .pending_command()
            .unwrap();
        assert_eq!(pending.attempts(), 3);
        assert!(!reconciler.device_state(&lamp).unwrap().in_sync());
        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.5), at(7.1))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn matching_observation_cancels_pending_retry() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();

        reconciler
            .observe(&lamp, device_target(0.5), at(1.1))
            .unwrap();

        assert!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .is_none()
        );
        assert!(reconciler.retry_due(at(10.0)).unwrap().is_empty());
    }

    #[test]
    fn partial_observations_merge_before_clearing_pending_retry() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();

        reconciler
            .observe(
                &lamp,
                DeviceTarget {
                    on: Some(true),
                    brightness: Some(Brightness::new(0.5).unwrap()),
                    color_temperature: None,
                    color: None,
                    transition_ms: None,
                },
                at(1.1),
            )
            .unwrap();
        assert!(!reconciler.device_state(&lamp).unwrap().in_sync());

        reconciler
            .observe(
                &lamp,
                DeviceTarget {
                    on: None,
                    brightness: None,
                    color_temperature: Some(Kelvin::new(2700.0).unwrap()),
                    color: None,
                    transition_ms: None,
                },
                at(1.2),
            )
            .unwrap();

        assert!(reconciler.device_state(&lamp).unwrap().in_sync());
        assert!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .is_none()
        );
    }

    #[test]
    fn reconnect_and_availability_recovery_reset_retry_budget() {
        let lamp = id("lamp");
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            RetryPolicy::new(1.0, 2).unwrap(),
        )
        .unwrap();
        reconciler.broker_connected(at(0.0)).unwrap();
        reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        reconciler.retry_due(at(2.0)).unwrap();
        assert!(reconciler.retry_due(at(3.0)).unwrap().is_empty());

        reconciler.broker_disconnected(at(4.0)).unwrap();
        let reconnect = reconciler.broker_connected(at(5.0)).unwrap();
        assert!(
            reconnect
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
        assert_eq!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .unwrap()
                .attempts(),
            1
        );

        reconciler
            .set_device_availability(&lamp, Availability::Offline, at(5.1))
            .unwrap();
        reconciler
            .set_device_availability(&lamp, Availability::Online, at(5.2))
            .unwrap();
        assert_eq!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .unwrap()
                .attempts(),
            1
        );
    }

    #[test]
    fn retry_policy_and_clock_failures_are_validated_and_atomic() {
        for (seconds, attempts) in [
            (0.0, 1),
            (-1.0, 1),
            (f64::NAN, 1),
            (f64::INFINITY, 1),
            (1.0, 0),
            (1.0, 11),
        ] {
            assert!(RetryPolicy::new(seconds, attempts).is_err());
        }

        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let before_regression = reconciler.clone();
        assert!(reconciler.retry_due(at(0.5)).is_err());
        assert_eq!(reconciler, before_regression);

        let overflow_lamp = id("overflow_lamp");
        let mut overflow = connected_reconciler(vec![DeviceDefinition::new(
            overflow_lamp.clone(),
            capabilities(),
        )]);
        let before_overflow = overflow.clone();
        assert!(
            overflow
                .set_device_desired(&overflow_lamp, target(0.5), at(f64::MAX))
                .is_err()
        );
        assert_eq!(overflow, before_overflow);
    }

    fn on_only_capabilities() -> Capabilities {
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

    fn color_capabilities() -> Capabilities {
        Capabilities {
            color_xy: true,
            color_temperature: None,
            ..capabilities()
        }
    }

    #[test]
    fn heterogeneous_group_sends_common_fields_once_and_only_missing_member_fields() {
        let color_lamp = id("color_lamp");
        let cct_lamp = id("cct_lamp");
        let switch = id("switch");
        let group = entity("mixed_group");
        let group_capabilities = Capabilities {
            color_temperature: None,
            ..capabilities()
        };
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(color_lamp.clone(), color_capabilities()),
                DeviceDefinition::new(cct_lamp.clone(), capabilities()),
                DeviceDefinition::new(switch.clone(), on_only_capabilities()),
            ],
            vec![
                GroupDefinition::new(
                    group.clone(),
                    vec![switch.clone(), cct_lamp.clone(), color_lamp.clone()],
                    group_capabilities,
                )
                .unwrap(),
            ],
            retry_policy(),
        )
        .unwrap();
        reconciler.broker_connected(at(0.0)).unwrap();
        let logical = LightTarget {
            on: true,
            brightness: Some(Brightness::new(0.6).unwrap()),
            color_temperature: Some(Kelvin::new(3000.0).unwrap()),
            color: Some(Color::xy(0.2, 0.3).unwrap()),
            transition_ms: Some(500),
        };

        let actions = reconciler
            .set_group_desired(&group, logical, at(1.0))
            .unwrap();

        assert_eq!(
            actions,
            vec![
                ReconcileAction::Command {
                    entity: CommandEntity::Group(group),
                    target: DeviceTarget {
                        on: Some(true),
                        brightness: Some(Brightness::new(0.6).unwrap()),
                        color_temperature: None,
                        color: None,
                        transition_ms: Some(500),
                    },
                },
                ReconcileAction::Command {
                    entity: CommandEntity::Device(cct_lamp.clone()),
                    target: DeviceTarget {
                        on: None,
                        brightness: None,
                        color_temperature: Some(Kelvin::new(3000.0).unwrap()),
                        color: None,
                        transition_ms: Some(500),
                    },
                },
                ReconcileAction::Command {
                    entity: CommandEntity::Device(color_lamp.clone()),
                    target: DeviceTarget {
                        on: None,
                        brightness: None,
                        color_temperature: None,
                        color: Some(Color::xy(0.2, 0.3).unwrap()),
                        transition_ms: Some(500),
                    },
                },
            ]
        );
        assert_eq!(
            reconciler
                .device_state(&color_lamp)
                .unwrap()
                .pending_command()
                .unwrap()
                .target(),
            color_capabilities().degrade(&logical)
        );
        assert_eq!(
            reconciler
                .device_state(&switch)
                .unwrap()
                .pending_command()
                .unwrap()
                .target(),
            on_only_capabilities().degrade(&logical)
        );
    }

    #[test]
    fn empty_group_command_falls_back_to_members_only() {
        let lamp = id("lamp");
        let group = entity("empty_group_capability");
        let empty = Capabilities {
            on_off: false,
            dimming: false,
            color_temperature: None,
            color_xy: false,
            color_hs: false,
            input: false,
            occupancy: false,
            temperature: false,
            power_metering: false,
        };
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            vec![GroupDefinition::new(group.clone(), vec![lamp.clone()], empty).unwrap()],
            retry_policy(),
        )
        .unwrap();
        reconciler.broker_connected(at(0.0)).unwrap();

        assert_eq!(
            reconciler
                .set_group_desired(&group, target(0.4), at(1.0))
                .unwrap(),
            vec![ReconcileAction::Command {
                entity: CommandEntity::Device(lamp),
                target: device_target(0.4),
            }]
        );
    }
}
