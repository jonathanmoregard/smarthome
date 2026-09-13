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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DispatchToken(u64);

impl DispatchToken {
    pub fn get(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReconcileAction {
    Resubscribe,
    RequestState(DeviceId),
    Command {
        token: DispatchToken,
        entity: CommandEntity,
        target: DeviceTarget,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct StagedDispatch {
    commands: Vec<(CommandEntity, DeviceTarget)>,
    affected: BTreeMap<DeviceId, StagedAttempt>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct StagedAttempt {
    target: DeviceTarget,
    attempts: u8,
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
    next_dispatch_token: u64,
    staged_dispatches: BTreeMap<DispatchToken, StagedDispatch>,
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
            next_dispatch_token: 1,
            staged_dispatches: BTreeMap::new(),
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
            next.staged_dispatches.clear();
            Ok(Vec::new())
        })?;
        Ok(())
    }

    pub fn broker_connected(
        &mut self,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, _| {
            next.transport = TransportStatus::Connected;
            let mut actions = vec![ReconcileAction::Resubscribe];
            actions.extend(
                next.devices
                    .keys()
                    .cloned()
                    .map(ReconcileAction::RequestState),
            );
            actions.extend(next.reconcile_all()?);
            Ok(actions)
        })
    }

    pub fn set_bridge_availability(
        &mut self,
        availability: Availability,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, _| {
            let previous = next.bridge;
            next.bridge = availability;
            if previous == Availability::Offline && availability != Availability::Offline {
                next.reconcile_all()
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
        self.transact(now, |next, _| {
            let state = next
                .devices
                .get_mut(id)
                .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
            let previous = state.availability;
            state.availability = availability;
            if availability == Availability::Offline {
                state.pending = None;
                next.invalidate_staged_for_device(id);
            }
            if previous == Availability::Offline && availability != Availability::Offline {
                next.command_device(id, 1)
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
        self.transact(now, |next, _| {
            let in_sync = {
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
                state.in_sync
            };
            next.invalidate_staged_for_device(id);
            if in_sync {
                return Ok(Vec::new());
            }
            next.command_device(id, 1)
        })
    }

    pub fn set_group_desired(
        &mut self,
        id: &EntityId,
        target: LightTarget,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, _| next.set_group_desired_inner(id, target))
    }

    fn set_group_desired_inner(
        &mut self,
        id: &EntityId,
        target: LightTarget,
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
        for member in &changed_members {
            self.invalidate_staged_for_device(member);
        }

        self.command_group_with_fallbacks(
            id,
            &members,
            group_target,
            group_target_changed,
            &changed_members,
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
        self.transact(now, |next, _| {
            let state = next
                .devices
                .get_mut(id)
                .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
            state.observed = None;
            state.pending = None;
            state.in_sync = state.desired.is_none();
            next.invalidate_staged_for_device(id);
            if next.transport != TransportStatus::Connected {
                return Ok(Vec::new());
            }
            let mut actions = vec![ReconcileAction::RequestState(id.clone())];
            actions.extend(next.command_device(id, 1)?);
            Ok(actions)
        })
    }

    /// Records a complete command batch only after the MQTT client accepted
    /// every publication in that batch. Adapter encoding and enqueue failures
    /// must call `dispatch_failed` instead.
    pub fn dispatch_succeeded(
        &mut self,
        token: DispatchToken,
        now: MonotonicTime,
    ) -> Result<(), ReconcileError> {
        self.transact(now, |next, now| {
            let staged = next
                .staged_dispatches
                .remove(&token)
                .ok_or(ReconcileError::UnknownDispatchToken(token))?;
            let deadline = next.retry_policy.deadline(now)?;
            for (id, attempt) in staged.affected {
                let state = next
                    .devices
                    .get_mut(&id)
                    .expect("staged dispatch references a configured device");
                state.last_command = Some(attempt.target);
                state.in_sync = targets_in_sync(state.desired, state.observed);
                state.pending = (!state.in_sync).then_some(PendingCommand {
                    target: attempt.target,
                    deadline,
                    attempts: attempt.attempts,
                });
            }
            Ok(Vec::new())
        })?;
        Ok(())
    }

    /// Clears a rejected batch and immediately stages the same logical batch
    /// with a fresh token. Failed local encoding/enqueue attempts do not spend
    /// the bounded on-wire retry budget.
    pub fn dispatch_failed(
        &mut self,
        token: DispatchToken,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, _| {
            let staged = next
                .staged_dispatches
                .remove(&token)
                .ok_or(ReconcileError::UnknownDispatchToken(token))?;
            if !next.can_publish()
                || !staged.affected.iter().any(|(id, attempt)| {
                    next.devices.get(id).is_some_and(|state| {
                        state.availability != Availability::Offline
                            && state.desired == Some(attempt.target)
                            && !targets_in_sync(state.desired, state.observed)
                    })
                })
            {
                return Ok(Vec::new());
            }
            next.stage_dispatch(staged.commands, staged.affected)
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
        let staged_devices: BTreeSet<_> = self
            .staged_dispatches
            .values()
            .flat_map(|dispatch| dispatch.affected.keys().cloned())
            .collect();
        let mut actions = Vec::new();
        for (id, pending) in due {
            let state = self
                .devices
                .get(&id)
                .expect("due command came from configured device");
            if state.availability == Availability::Offline
                || pending.attempts >= self.retry_policy.max_attempts
                || staged_devices.contains(&id)
            {
                continue;
            }
            let affected = BTreeMap::from([(
                id.clone(),
                StagedAttempt {
                    target: pending.target,
                    attempts: pending.attempts + 1,
                },
            )]);
            actions.extend(
                self.stage_dispatch(vec![(CommandEntity::Device(id), pending.target)], affected)?,
            );
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
        attempts: u8,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        if !self.can_publish() {
            return Ok(Vec::new());
        }
        let state = self
            .devices
            .get(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
        if state.availability == Availability::Offline {
            return Ok(Vec::new());
        }
        let Some(desired) = state.desired else {
            return Ok(Vec::new());
        };
        self.stage_dispatch(
            vec![(CommandEntity::Device(id.clone()), desired)],
            BTreeMap::from([(
                id.clone(),
                StagedAttempt {
                    target: desired,
                    attempts,
                },
            )]),
        )
    }

    fn stage_dispatch(
        &mut self,
        commands: Vec<(CommandEntity, DeviceTarget)>,
        affected: BTreeMap<DeviceId, StagedAttempt>,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        if commands.is_empty() || affected.is_empty() {
            return Ok(Vec::new());
        }
        let token_value = self.next_dispatch_token;
        self.next_dispatch_token = token_value
            .checked_add(1)
            .ok_or(ReconcileError::DispatchTokenOverflow)?;
        let token = DispatchToken(token_value);
        let actions = commands
            .iter()
            .cloned()
            .map(|(entity, target)| ReconcileAction::Command {
                token,
                entity,
                target,
            })
            .collect();
        let replaced = self
            .staged_dispatches
            .insert(token, StagedDispatch { commands, affected });
        debug_assert!(replaced.is_none());
        Ok(actions)
    }

    fn invalidate_staged_for_device(&mut self, id: &DeviceId) {
        self.staged_dispatches
            .retain(|_, dispatch| !dispatch.affected.contains_key(id));
    }

    fn command_group_with_fallbacks(
        &mut self,
        id: &EntityId,
        members: &[DeviceId],
        group_target: DeviceTarget,
        send_group: bool,
        changed_members: &BTreeSet<DeviceId>,
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
        let mut commands = Vec::new();
        let mut affected = BTreeMap::new();
        if group_sent {
            commands.push((CommandEntity::Group(id.clone()), group_target));
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
                commands.push((CommandEntity::Device(member.clone()), fallback));
            }
            if group_sent || fallback_sent {
                affected.insert(
                    member,
                    StagedAttempt {
                        target: desired,
                        attempts: 1,
                    },
                );
            }
        }
        self.stage_dispatch(commands, affected)
    }

    fn reconcile_all(&mut self) -> Result<Vec<ReconcileAction>, ReconcileError> {
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
            )?);
        }

        let ungrouped: Vec<_> = self
            .devices
            .keys()
            .filter(|id| !grouped.contains(*id))
            .cloned()
            .collect();
        for id in ungrouped {
            actions.extend(self.command_device(&id, 1)?);
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
            _ => {
                let desired_xy = desired
                    .hs_components()
                    .map(|(hue, saturation)| hs_to_srgb_xy(hue, saturation))
                    .or_else(|| desired.xy_components());
                let observed_xy = observed
                    .hs_components()
                    .map(|(hue, saturation)| hs_to_srgb_xy(hue, saturation))
                    .or_else(|| observed.xy_components());
                matches!((desired_xy, observed_xy), (Some((dx, dy)), Some((ox, oy))) if (dx - ox).hypot(dy - oy) <= 0.03)
            }
        },
    }
}

/// Converts normalized HS through a canonical full-value sRGB/D65 color.
/// Zigbee lamps have model-specific gamuts, so cross-mode observations use a
/// deliberately modest chromaticity tolerance instead of pretending their
/// reported XY values are bit-exact sRGB coordinates.
fn hs_to_srgb_xy(hue: f64, saturation: f64) -> (f64, f64) {
    let chroma = saturation;
    let sector = (hue.rem_euclid(360.0) / 60.0).min(5.999_999_999);
    let intermediate = chroma * (1.0 - ((sector % 2.0) - 1.0).abs());
    let (red, green, blue) = match sector.floor() as u8 {
        0 => (chroma, intermediate, 0.0),
        1 => (intermediate, chroma, 0.0),
        2 => (0.0, chroma, intermediate),
        3 => (0.0, intermediate, chroma),
        4 => (intermediate, 0.0, chroma),
        _ => (chroma, 0.0, intermediate),
    };
    let offset = 1.0 - chroma;
    let linear = |channel: f64| {
        let channel = channel + offset;
        if channel <= 0.04045 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    };
    let red = linear(red);
    let green = linear(green);
    let blue = linear(blue);
    let x_tristimulus = 0.412_456_4 * red + 0.357_576_1 * green + 0.180_437_5 * blue;
    let y_tristimulus = 0.212_672_9 * red + 0.715_152_2 * green + 0.072_175 * blue;
    let z_tristimulus = 0.019_333_9 * red + 0.119_192 * green + 0.950_304_1 * blue;
    let sum = x_tristimulus + y_tristimulus + z_tristimulus;
    (x_tristimulus / sum, y_tristimulus / sum)
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReconcileError {
    InvalidIdentifier,
    InvalidRetryInterval,
    InvalidRetryAttempts,
    RetryDeadlineOverflow,
    DispatchTokenOverflow,
    UnknownDispatchToken(DispatchToken),
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
            Self::DispatchTokenOverflow => formatter.write_str("dispatch token space exhausted"),
            Self::UnknownDispatchToken(token) => {
                write!(formatter, "unknown or completed dispatch token {}", token.get())
            }
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
    use std::collections::BTreeSet;

    use crate::state::MonotonicTime;
    use crate::value::{
        Brightness, Capabilities, Color, DeviceTarget, Kelvin, KelvinRange, LightTarget,
    };

    use super::{
        Availability, CommandEntity, DeviceDefinition, DeviceId, DispatchToken, EntityId,
        GroupDefinition, ReconcileAction, Reconciler, RetryPolicy, TransportStatus,
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
                token: DispatchToken(1),
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
                token: DispatchToken(1),
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
                token: DispatchToken(1),
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
                token: DispatchToken(1),
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
                token: DispatchToken(2),
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
                    token: DispatchToken(3),
                    entity: CommandEntity::Device(lamp_a),
                    target: device_target(0.2),
                },
                ReconcileAction::Command {
                    token: DispatchToken(4),
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
                    token: DispatchToken(3),
                    entity: CommandEntity::Group(group),
                    target: device_target(0.8),
                },
                ReconcileAction::Command {
                    token: DispatchToken(4),
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
                    token: DispatchToken(2),
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
        let first = ReconcileAction::Command {
            token: DispatchToken(1),
            entity: CommandEntity::Device(lamp.clone()),
            target: device_target(0.5),
        };
        assert_eq!(
            reconciler
                .set_device_desired(&lamp, target(0.5), at(1.0))
                .unwrap(),
            vec![first]
        );
        reconciler
            .dispatch_succeeded(DispatchToken(1), at(1.0))
            .unwrap();
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
            vec![ReconcileAction::Command {
                token: DispatchToken(2),
                entity: CommandEntity::Device(lamp.clone()),
                target: device_target(0.5),
            }]
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
            .dispatch_succeeded(DispatchToken(2), at(3.0))
            .unwrap();
        assert_eq!(
            reconciler
                .observe(&lamp, device_target(0.2), at(3.1))
                .unwrap(),
            Vec::new()
        );
        assert_eq!(
            reconciler.retry_due(at(5.0)).unwrap(),
            vec![ReconcileAction::Command {
                token: DispatchToken(3),
                entity: CommandEntity::Device(lamp.clone()),
                target: device_target(0.5),
            }]
        );
        reconciler
            .dispatch_succeeded(DispatchToken(3), at(5.0))
            .unwrap();
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
            .dispatch_succeeded(DispatchToken(1), at(1.0))
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
            .dispatch_succeeded(DispatchToken(1), at(1.0))
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
        let initial = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = initial[0] else {
            unreachable!()
        };
        reconciler.dispatch_succeeded(token, at(1.0)).unwrap();
        let retry = reconciler.retry_due(at(2.0)).unwrap();
        let ReconcileAction::Command { token, .. } = retry[0] else {
            unreachable!()
        };
        reconciler.dispatch_succeeded(token, at(2.0)).unwrap();
        assert!(reconciler.retry_due(at(3.0)).unwrap().is_empty());

        reconciler.broker_disconnected(at(4.0)).unwrap();
        let reconnect = reconciler.broker_connected(at(5.0)).unwrap();
        assert!(
            reconnect
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
        let token = reconnect
            .iter()
            .find_map(|action| match action {
                ReconcileAction::Command { token, .. } => Some(*token),
                _ => None,
            })
            .unwrap();
        reconciler.dispatch_succeeded(token, at(5.0)).unwrap();
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
        let recovered = reconciler
            .set_device_availability(&lamp, Availability::Online, at(5.2))
            .unwrap();
        let ReconcileAction::Command { token, .. } = recovered[0] else {
            unreachable!()
        };
        reconciler.dispatch_succeeded(token, at(5.2)).unwrap();
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
        let staged = overflow
            .set_device_desired(&overflow_lamp, target(0.5), at(f64::MAX))
            .unwrap();
        let ReconcileAction::Command { token, .. } = staged[0] else {
            unreachable!()
        };
        let before_overflow = overflow.clone();
        assert_eq!(
            overflow.dispatch_succeeded(token, at(f64::MAX)),
            Err(super::ReconcileError::RetryDeadlineOverflow)
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
                    token: DispatchToken(1),
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
                    token: DispatchToken(1),
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
                    token: DispatchToken(1),
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
        reconciler
            .dispatch_succeeded(DispatchToken(1), at(1.0))
            .unwrap();
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
                token: DispatchToken(1),
                entity: CommandEntity::Device(lamp),
                target: device_target(0.4),
            }]
        );
    }

    #[test]
    fn dispatch_is_not_accounted_until_wire_acceptance() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);

        let actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            panic!("expected staged command")
        };
        assert_eq!(reconciler.device_state(&lamp).unwrap().last_command(), None);
        assert!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .is_none()
        );

        reconciler.dispatch_succeeded(token, at(1.1)).unwrap();
        let pending = reconciler
            .device_state(&lamp)
            .unwrap()
            .pending_command()
            .unwrap();
        assert_eq!(pending.attempts(), 1);
        assert_eq!(pending.deadline(), at(3.1));
        assert_eq!(pending.target(), device_target(0.5));

        let before_duplicate_callback = reconciler.clone();
        assert_eq!(
            reconciler.dispatch_succeeded(token, at(1.2)),
            Err(super::ReconcileError::UnknownDispatchToken(token))
        );
        assert_eq!(reconciler, before_duplicate_callback);
    }

    #[test]
    fn failed_dispatch_restages_without_spending_retry_budget() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let first = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command {
            token: first_token, ..
        } = first[0]
        else {
            panic!("expected staged command")
        };

        let retry = reconciler.dispatch_failed(first_token, at(1.1)).unwrap();
        let ReconcileAction::Command {
            token: retry_token, ..
        } = retry[0]
        else {
            panic!("expected restaged command")
        };
        assert_ne!(first_token, retry_token);
        assert!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .is_none()
        );

        reconciler.dispatch_succeeded(retry_token, at(1.2)).unwrap();
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
    fn repeated_local_dispatch_failures_never_exhaust_on_wire_attempts() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let mut actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();

        for step in 1..=20 {
            let ReconcileAction::Command { token, .. } = actions[0] else {
                unreachable!()
            };
            actions = reconciler
                .dispatch_failed(token, at(1.0 + f64::from(step) / 100.0))
                .unwrap();
            assert!(
                reconciler
                    .device_state(&lamp)
                    .unwrap()
                    .pending_command()
                    .is_none()
            );
        }

        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        reconciler.dispatch_succeeded(token, at(1.21)).unwrap();
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
    fn group_and_fallback_publications_share_one_atomic_dispatch_token() {
        let full = id("full");
        let limited = id("limited");
        let group = entity("room");
        let group_capabilities = Capabilities {
            color_temperature: None,
            ..capabilities()
        };
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(full.clone(), capabilities()),
                DeviceDefinition::new(limited.clone(), on_only_capabilities()),
            ],
            vec![
                GroupDefinition::new(
                    group.clone(),
                    vec![full.clone(), limited.clone()],
                    group_capabilities,
                )
                .unwrap(),
            ],
            retry_policy(),
        )
        .unwrap();
        reconciler.broker_connected(at(0.0)).unwrap();

        let actions = reconciler
            .set_group_desired(&group, target(0.5), at(1.0))
            .unwrap();
        let tokens: BTreeSet<_> = actions
            .iter()
            .filter_map(|action| match action {
                ReconcileAction::Command { token, .. } => Some(*token),
                _ => None,
            })
            .collect();
        assert_eq!(tokens.len(), 1);
        assert!(reconciler.device_state(&full).unwrap().pending.is_none());
        assert!(reconciler.device_state(&limited).unwrap().pending.is_none());

        reconciler
            .dispatch_succeeded(*tokens.first().unwrap(), at(1.1))
            .unwrap();
        assert!(reconciler.device_state(&full).unwrap().pending.is_some());
        assert!(reconciler.device_state(&limited).unwrap().pending.is_some());
    }

    #[test]
    fn disconnect_invalidates_staged_dispatch_and_reconnect_restages() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let first = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = first[0] else {
            panic!("expected staged command")
        };

        reconciler.broker_disconnected(at(1.1)).unwrap();
        let before = reconciler.clone();
        assert_eq!(
            reconciler.dispatch_succeeded(token, at(1.2)),
            Err(super::ReconcileError::UnknownDispatchToken(token))
        );
        assert_eq!(reconciler, before);
        assert!(
            reconciler
                .broker_connected(at(1.3))
                .unwrap()
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
    }

    #[test]
    fn equivalent_hs_and_xy_observations_reconcile_but_different_colors_do_not() {
        assert!(super::colors_in_sync(
            Color::hs(0.0, 1.0).unwrap(),
            Color::xy(0.64, 0.33).unwrap(),
        ));
        assert!(!super::colors_in_sync(
            Color::hs(0.0, 1.0).unwrap(),
            Color::xy(0.15, 0.06).unwrap(),
        ));
    }

    #[test]
    fn dispatch_token_overflow_is_atomic() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler.next_dispatch_token = u64::MAX;
        let before = reconciler.clone();

        assert_eq!(
            reconciler.set_device_desired(&lamp, target(0.5), at(1.0)),
            Err(super::ReconcileError::DispatchTokenOverflow)
        );
        assert_eq!(reconciler, before);
    }
}
