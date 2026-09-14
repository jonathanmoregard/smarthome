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
    dispatch_acceptance_timeout_seconds: f64,
    dispatch_failure_backoff_seconds: f64,
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
            dispatch_acceptance_timeout_seconds: 5.0,
            dispatch_failure_backoff_seconds: 0.5,
        })
    }

    /// Configures local dispatch acknowledgement and retry timing.
    ///
    /// The acceptance timeout is a margin added after the adapter's largest
    /// registered plan-relative publication delay. The executor must drive
    /// `retry_due` often enough to sweep expired staged tokens and release
    /// deferred work at its deadline.
    pub fn with_dispatch_timing(
        mut self,
        acceptance_timeout_seconds: f64,
        failure_backoff_seconds: f64,
    ) -> Result<Self, ReconcileError> {
        if !acceptance_timeout_seconds.is_finite() || acceptance_timeout_seconds <= 0.0 {
            return Err(ReconcileError::InvalidDispatchAcceptanceTimeout);
        }
        if !failure_backoff_seconds.is_finite() || failure_backoff_seconds <= 0.0 {
            return Err(ReconcileError::InvalidDispatchFailureBackoff);
        }
        self.dispatch_acceptance_timeout_seconds = acceptance_timeout_seconds;
        self.dispatch_failure_backoff_seconds = failure_backoff_seconds;
        Ok(self)
    }

    fn correlation_deadline(self, now: MonotonicTime, transition_ms: Option<u64>) -> MonotonicTime {
        let transition_seconds = transition_ms.unwrap_or_default() as f64 / 1000.0;
        saturating_deadline(now, transition_seconds + self.interval_seconds)
    }

    fn dispatch_acceptance_deadline(
        self,
        epoch: MonotonicTime,
        max_offset_ms: u64,
    ) -> Result<MonotonicTime, ReconcileError> {
        let max_offset_seconds = max_offset_ms as f64 / 1000.0;
        checked_deadline(
            epoch,
            max_offset_seconds + self.dispatch_acceptance_timeout_seconds,
            ReconcileError::DispatchAcceptanceDeadlineOverflow,
        )
    }

    fn dispatch_failure_deadline(
        self,
        now: MonotonicTime,
    ) -> Result<MonotonicTime, ReconcileError> {
        checked_deadline(
            now,
            self.dispatch_failure_backoff_seconds,
            ReconcileError::DispatchFailureDeadlineOverflow,
        )
    }
}

fn checked_deadline(
    now: MonotonicTime,
    offset_seconds: f64,
    overflow: ReconcileError,
) -> Result<MonotonicTime, ReconcileError> {
    let seconds = now.seconds() + offset_seconds;
    if !seconds.is_finite() || seconds <= now.seconds() {
        return Err(overflow);
    }
    MonotonicTime::from_seconds(seconds).map_err(|_| overflow)
}

fn saturating_deadline(now: MonotonicTime, offset_seconds: f64) -> MonotonicTime {
    let seconds = now.seconds() + offset_seconds;
    let seconds = if seconds.is_finite() && seconds > now.seconds() {
        seconds
    } else {
        f64::MAX
    };
    MonotonicTime::from_seconds(seconds).expect("finite nonnegative saturated monotonic deadline")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorGamut {
    red: (f64, f64),
    green: (f64, f64),
    blue: (f64, f64),
}

impl ColorGamut {
    pub fn new(
        red: (f64, f64),
        green: (f64, f64),
        blue: (f64, f64),
    ) -> Result<Self, ReconcileError> {
        let points = [red, green, blue];
        if points.into_iter().any(|(x, y)| {
            !x.is_finite()
                || !y.is_finite()
                || !(0.0..=1.0).contains(&x)
                || !(0.0..=1.0).contains(&y)
                || x + y > 1.0
        }) {
            return Err(ReconcileError::InvalidColorGamut);
        }
        let twice_area = cross(subtract(green, red), subtract(blue, red)).abs();
        if twice_area <= 1.0e-6 {
            return Err(ReconcileError::InvalidColorGamut);
        }
        Ok(Self { red, green, blue })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorComparisonPolicy {
    gamut: Option<ColorGamut>,
    xy_tolerance: f64,
    achromatic_saturation_threshold: f64,
}

impl ColorComparisonPolicy {
    pub fn new(
        gamut: Option<ColorGamut>,
        xy_tolerance: f64,
        achromatic_saturation_threshold: f64,
    ) -> Result<Self, ReconcileError> {
        if !xy_tolerance.is_finite() || xy_tolerance <= 0.0 || xy_tolerance > 1.0 {
            return Err(ReconcileError::InvalidColorComparisonPolicy);
        }
        if !achromatic_saturation_threshold.is_finite()
            || !(0.0..=1.0).contains(&achromatic_saturation_threshold)
        {
            return Err(ReconcileError::InvalidColorComparisonPolicy);
        }
        Ok(Self {
            gamut,
            xy_tolerance,
            achromatic_saturation_threshold,
        })
    }
}

impl Default for ColorComparisonPolicy {
    fn default() -> Self {
        Self {
            gamut: None,
            xy_tolerance: 0.03,
            achromatic_saturation_threshold: 0.02,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceDefinition {
    id: DeviceId,
    capabilities: Capabilities,
    color_policy: ColorComparisonPolicy,
}

impl DeviceDefinition {
    pub fn new(id: DeviceId, capabilities: Capabilities) -> Self {
        Self {
            id,
            capabilities,
            color_policy: ColorComparisonPolicy::default(),
        }
    }

    pub fn with_color_policy(
        id: DeviceId,
        capabilities: Capabilities,
        color_policy: ColorComparisonPolicy,
    ) -> Self {
        Self {
            id,
            capabilities,
            color_policy,
        }
    }

    pub fn id(&self) -> &DeviceId {
        &self.id
    }

    pub fn capabilities(&self) -> Capabilities {
        self.capabilities
    }
}

/// A native Zigbee synchronization group.
///
/// Physical command groups must not overlap: one device may belong to at most
/// one such group. Logical room/floor/house scopes are separate and can fan out
/// across several native groups and individual devices.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchRegistrationOutcome {
    Registered,
    AlreadyRegistered,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchAcceptance {
    OperationAccepted { remaining: usize },
    BatchAccepted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchCancellation {
    Cancelled,
    Stale,
}

/// Result of claiming one ordered publication from a registered dispatch plan.
///
/// `Ready` contains a permit borrowing the reconciler mutably. The executor
/// must retain that permit across the asynchronous MQTT enqueue and then
/// consume it with exactly one completion method. This makes a desired-state
/// mutation through the same single-owner actor impossible while enqueue is in
/// flight. A stale or previously accepted publication is skipped benignly.
pub enum DispatchClaim<'a> {
    Ready(DispatchPermit<'a>),
    AlreadyAccepted,
    Stale,
}

/// Exclusive lease for one MQTT publication in a dispatch batch.
///
/// Holding this value keeps a mutable borrow of the reconciler. Runtime code
/// must keep the reconciler in one actor and hold the permit across `.await`;
/// do not introduce a second mutex-backed mutation path around this contract.
#[must_use = "a dispatch permit must be completed or deliberately dropped for timeout recovery"]
pub struct DispatchPermit<'a> {
    reconciler: &'a mut Reconciler,
    token: DispatchToken,
    operation_index: usize,
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
    affected: BTreeMap<DeviceId, StagedAttempt>,
    plan: Option<RegisteredDispatchPlan>,
    acceptance_deadline: MonotonicTime,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct RegisteredDispatchPlan {
    epoch: MonotonicTime,
    operation_count: usize,
    max_offset_ms: u64,
    next_operation_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct StagedAttempt {
    target: DeviceTarget,
    attempts: u8,
}

#[derive(Debug, Clone, PartialEq)]
struct DeferredDispatch {
    affected_attempts: BTreeMap<DeviceId, u8>,
    retry_deadline: MonotonicTime,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceState {
    capabilities: Capabilities,
    color_policy: ColorComparisonPolicy,
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
    fn new(capabilities: Capabilities, color_policy: ColorComparisonPolicy) -> Self {
        Self {
            capabilities,
            color_policy,
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
    next_deferred_sequence: u64,
    deferred_dispatches: BTreeMap<u64, DeferredDispatch>,
    last_time: Option<MonotonicTime>,
}

impl DispatchPermit<'_> {
    /// Records this publication as accepted by the MQTT client.
    ///
    /// The final operation completes the atomic batch and starts each affected
    /// device's on-wire correlation deadline after its hardware transition;
    /// earlier operations only advance plan progress.
    pub fn accepted(self, now: MonotonicTime) -> Result<DispatchAcceptance, ReconcileError> {
        self.reconciler
            .accept_dispatch_operation(self.token, self.operation_index, now)
    }

    /// Moves the entire batch to local-failure backoff without consuming an
    /// on-wire attempt, including when earlier operations were accepted.
    pub fn transient_failure(self, now: MonotonicTime) -> Result<(), ReconcileError> {
        self.reconciler
            .fail_dispatch_operation(self.token, self.operation_index, now)
    }

    /// Cancels the entire batch after a permanent adapter/configuration error.
    pub fn permanent_failure(self, now: MonotonicTime) -> Result<(), ReconcileError> {
        self.reconciler
            .cancel_claimed_dispatch(self.token, self.operation_index, now)
    }
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
                    slot.insert(DeviceState::new(
                        definition.capabilities,
                        definition.color_policy,
                    ));
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
            next_deferred_sequence: 1,
            deferred_dispatches: BTreeMap::new(),
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

    pub fn next_deadline(&self) -> Option<MonotonicTime> {
        self.staged_dispatches
            .values()
            .map(|dispatch| dispatch.acceptance_deadline)
            .chain(
                self.deferred_dispatches
                    .values()
                    .map(|dispatch| dispatch.retry_deadline),
            )
            .chain(self.devices.values().filter_map(|device| {
                device
                    .pending
                    .filter(|pending| pending.attempts < self.retry_policy.max_attempts)
                    .map(|pending| pending.deadline)
            }))
            .min_by(|left, right| left.as_seconds().total_cmp(&right.as_seconds()))
    }

    /// Returns whether a staged batch still exists for diagnostics/tests.
    ///
    /// This observation does not authorize an enqueue: executors must use
    /// `claim_next_operation` so token validation and the enqueue lease cannot
    /// race. A broker disconnect, newer desired state, timeout sweep, failure,
    /// or permanent cancellation invalidates the token.
    pub fn is_dispatch_token_valid(&self, token: DispatchToken) -> bool {
        self.staged_dispatches.contains_key(&token)
    }

    /// Registers the execution shape of one adapter plan before any of its
    /// publications are enqueued.
    ///
    /// Staging installs an initial deadline using its transaction time and the
    /// acceptance margin. Registration atomically extends it, when necessary,
    /// to the plan epoch plus its largest relative delay and the same margin.
    /// A token that a newer desired state already invalidated returns `Stale`
    /// rather than turning a normal actor race into a daemon error.
    pub fn register_dispatch_plan(
        &mut self,
        token: DispatchToken,
        epoch: MonotonicTime,
        operation_count: usize,
        max_offset_ms: u64,
    ) -> Result<DispatchRegistrationOutcome, ReconcileError> {
        if !self.staged_dispatches.contains_key(&token) {
            return Ok(DispatchRegistrationOutcome::Stale);
        }
        self.transact_value(epoch, |next, _| {
            if operation_count == 0 {
                return Err(ReconcileError::InvalidDispatchOperationCount);
            }
            let acceptance_deadline = next
                .retry_policy
                .dispatch_acceptance_deadline(epoch, max_offset_ms)?;
            let staged = next
                .staged_dispatches
                .get_mut(&token)
                .expect("token existence checked before transactional clone");
            let proposed = RegisteredDispatchPlan {
                epoch,
                operation_count,
                max_offset_ms,
                next_operation_index: 0,
            };
            match staged.plan {
                None => {
                    staged.plan = Some(proposed);
                    if acceptance_deadline > staged.acceptance_deadline {
                        staged.acceptance_deadline = acceptance_deadline;
                    }
                    Ok(DispatchRegistrationOutcome::Registered)
                }
                Some(existing)
                    if existing.epoch == epoch
                        && existing.operation_count == operation_count
                        && existing.max_offset_ms == max_offset_ms =>
                {
                    Ok(DispatchRegistrationOutcome::AlreadyRegistered)
                }
                Some(_) => Err(ReconcileError::DispatchPlanMismatch(token)),
            }
        })
    }

    /// Claims the next ordered operation for exclusive MQTT enqueue.
    ///
    /// Claims for invalidated tokens and already accepted indices are benign.
    /// Skipping forward is a malformed executor plan and remains an error.
    pub fn claim_next_operation(
        &mut self,
        token: DispatchToken,
        operation_index: usize,
    ) -> Result<DispatchClaim<'_>, ReconcileError> {
        let Some(staged) = self.staged_dispatches.get(&token) else {
            return Ok(DispatchClaim::Stale);
        };
        let plan = staged
            .plan
            .ok_or(ReconcileError::UnregisteredDispatchPlan(token))?;
        if operation_index < plan.next_operation_index {
            return Ok(DispatchClaim::AlreadyAccepted);
        }
        if operation_index != plan.next_operation_index || operation_index >= plan.operation_count {
            return Err(ReconcileError::UnexpectedDispatchOperation {
                expected: plan.next_operation_index,
                actual: operation_index,
                operation_count: plan.operation_count,
            });
        }
        Ok(DispatchClaim::Ready(DispatchPermit {
            reconciler: self,
            token,
            operation_index,
        }))
    }

    pub fn broker_disconnected(&mut self, now: MonotonicTime) -> Result<(), ReconcileError> {
        self.transact(now, |next, _| {
            next.transport = TransportStatus::Disconnected;
            next.bridge = Availability::Unknown;
            for state in next.devices.values_mut() {
                state.availability = Availability::Unknown;
                state.pending = None;
            }
            next.staged_dispatches.clear();
            next.deferred_dispatches.clear();
            Ok(Vec::new())
        })?;
        Ok(())
    }

    pub fn broker_connected(
        &mut self,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            if next.transport == TransportStatus::Connected {
                return Ok(Vec::new());
            }
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

    /// Reissues desired state only for devices whose bounded refresh is due.
    pub fn force_reconcile_devices(
        &mut self,
        devices: &BTreeSet<DeviceId>,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            if !next.can_publish() {
                return Ok(Vec::new());
            }
            let mut actions = Vec::new();
            for id in devices {
                actions.extend(next.command_device(id, 1, now)?);
            }
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
            if availability != Availability::Online {
                for state in next.devices.values_mut() {
                    state.availability = Availability::Unknown;
                    state.pending = None;
                }
                next.staged_dispatches.clear();
                next.deferred_dispatches.clear();
            }
            if previous != Availability::Online && availability == Availability::Online {
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
            let previous = {
                let state = next
                    .devices
                    .get_mut(id)
                    .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
                let previous = state.availability;
                state.availability = availability;
                if availability != Availability::Online {
                    state.pending = None;
                }
                previous
            };
            let canceled = if availability != Availability::Online {
                next.cancel_work_for_device(id)
            } else {
                BTreeSet::new()
            };
            let mut actions =
                next.stage_current_devices(canceled.into_iter().map(|id| (id, 1)).collect(), now)?;
            if previous != Availability::Online && availability == Availability::Online {
                actions.extend(next.command_device(id, 1, now)?);
            }
            Ok(actions)
        })
    }

    pub fn set_device_desired(
        &mut self,
        id: &DeviceId,
        target: LightTarget,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
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
                state.in_sync = targets_in_sync(state.desired, state.observed, state.color_policy);
                state.in_sync
            };
            let mut canceled = next.cancel_work_for_device(id);
            if in_sync {
                canceled.remove(id);
                return next
                    .stage_current_devices(canceled.into_iter().map(|id| (id, 1)).collect(), now);
            }
            canceled.insert(id.clone());
            next.stage_current_devices(canceled.into_iter().map(|id| (id, 1)).collect(), now)
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

    /// Stops native-group ownership without erasing member desired state.
    ///
    /// Runtime uses this before per-device fallback whenever group members do
    /// not share one physical owner or their effective targets diverge.
    pub fn clear_group_desired(
        &mut self,
        id: &EntityId,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        self.transact(now, |next, now| {
            let members = {
                let group = next
                    .groups
                    .get_mut(id)
                    .ok_or_else(|| ReconcileError::UnknownGroup(id.clone()))?;
                if group.logical_desired.is_none() && group.command_target.is_none() {
                    return Ok(Vec::new());
                }
                group.logical_desired = None;
                group.command_target = None;
                group.definition.members.clone()
            };
            let mut canceled = BTreeSet::new();
            for member in members {
                canceled.extend(next.cancel_work_for_device(&member));
                canceled.insert(member);
            }
            next.stage_current_devices(canceled.into_iter().map(|id| (id, 1)).collect(), now)
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
                state.in_sync = targets_in_sync(state.desired, state.observed, state.color_policy);
            }
        }
        let mut canceled = BTreeSet::new();
        for member in &changed_members {
            canceled.extend(self.cancel_work_for_device(member));
        }
        if !canceled.is_empty() {
            canceled.extend(changed_members);
            return self
                .stage_current_devices(canceled.into_iter().map(|id| (id, 1)).collect(), now);
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
        self.transact(now, |next, now| {
            let in_sync = {
                let state = next
                    .devices
                    .get_mut(id)
                    .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
                state.observed = Some(merge_observation(state.observed, observed));
                state.in_sync = targets_in_sync(state.desired, state.observed, state.color_policy);
                if state.in_sync {
                    state.pending = None;
                }
                state.in_sync
            };
            if !in_sync {
                return Ok(Vec::new());
            }
            let mut canceled = next.cancel_work_for_device(id);
            canceled.remove(id);
            next.stage_current_devices(canceled.into_iter().map(|id| (id, 1)).collect(), now)
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
            let canceled = next.cancel_work_for_device(id);
            if next.transport != TransportStatus::Connected {
                return Ok(Vec::new());
            }
            let mut actions = vec![ReconcileAction::RequestState(id.clone())];
            let mut affected: BTreeMap<_, _> = canceled.into_iter().map(|id| (id, 1)).collect();
            affected.insert(id.clone(), 1);
            actions.extend(next.stage_current_devices(affected, now)?);
            Ok(actions)
        })
    }

    fn accept_dispatch_operation(
        &mut self,
        token: DispatchToken,
        operation_index: usize,
        now: MonotonicTime,
    ) -> Result<DispatchAcceptance, ReconcileError> {
        self.transact_value(now, |next, now| {
            let (remaining, affected) = {
                let staged = next
                    .staged_dispatches
                    .get_mut(&token)
                    .ok_or(ReconcileError::UnknownDispatchToken(token))?;
                let plan = staged
                    .plan
                    .as_mut()
                    .ok_or(ReconcileError::UnregisteredDispatchPlan(token))?;
                if plan.next_operation_index != operation_index {
                    return Err(ReconcileError::UnexpectedDispatchOperation {
                        expected: plan.next_operation_index,
                        actual: operation_index,
                        operation_count: plan.operation_count,
                    });
                }
                plan.next_operation_index += 1;
                let remaining = plan.operation_count - plan.next_operation_index;
                (remaining, (remaining == 0).then(|| staged.affected.clone()))
            };
            if remaining != 0 {
                return Ok(DispatchAcceptance::OperationAccepted { remaining });
            }
            let affected = affected.expect("final operation clones affected batch");
            next.staged_dispatches
                .remove(&token)
                .expect("accepted token remains staged until its final operation");
            for (id, attempt) in affected {
                let deadline = next
                    .retry_policy
                    .correlation_deadline(now, attempt.target.transition_ms);
                let state = next
                    .devices
                    .get_mut(&id)
                    .expect("staged dispatch references a configured device");
                state.last_command = Some(attempt.target);
                state.in_sync = targets_in_sync(state.desired, state.observed, state.color_policy);
                state.pending = (!state.in_sync).then_some(PendingCommand {
                    target: attempt.target,
                    deadline,
                    attempts: attempt.attempts,
                });
            }
            Ok(DispatchAcceptance::BatchAccepted)
        })
    }

    fn fail_dispatch_operation(
        &mut self,
        token: DispatchToken,
        operation_index: usize,
        now: MonotonicTime,
    ) -> Result<(), ReconcileError> {
        self.transact_value(now, |next, now| {
            next.validate_claimed_operation(token, operation_index)?;
            let staged = next
                .staged_dispatches
                .remove(&token)
                .ok_or(ReconcileError::UnknownDispatchToken(token))?;
            next.defer_attempts(
                staged
                    .affected
                    .into_iter()
                    .map(|(id, attempt)| (id, attempt.attempts))
                    .collect(),
                now,
            )?;
            Ok(())
        })
    }

    fn cancel_claimed_dispatch(
        &mut self,
        token: DispatchToken,
        operation_index: usize,
        now: MonotonicTime,
    ) -> Result<(), ReconcileError> {
        self.transact_value(now, |next, _| {
            next.validate_claimed_operation(token, operation_index)?;
            next.staged_dispatches
                .remove(&token)
                .expect("claimed token remains staged while permit borrows reconciler");
            Ok(())
        })
    }

    /// Permanently cancels a staged batch.
    ///
    /// Use this for adapter configuration/encoding errors that cannot become
    /// healthy through transport retry. The adapter error remains the fatal
    /// diagnostic; this call only makes the token unusable and prevents retry.
    pub fn cancel_dispatch(
        &mut self,
        token: DispatchToken,
        now: MonotonicTime,
    ) -> Result<DispatchCancellation, ReconcileError> {
        self.transact_value(now, |next, _| {
            Ok(if next.staged_dispatches.remove(&token).is_some() {
                DispatchCancellation::Cancelled
            } else {
                DispatchCancellation::Stale
            })
        })
    }

    /// Sweeps dispatch-acceptance timeouts, releases local-failure backoff, and
    /// emits due on-wire retries. Call this from the executor's monotonic timer.
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
        let expired: Vec<_> = self
            .staged_dispatches
            .iter()
            .filter(|(_, dispatch)| now >= dispatch.acceptance_deadline)
            .map(|(token, _)| *token)
            .collect();
        for token in expired {
            let staged = self
                .staged_dispatches
                .remove(&token)
                .expect("expired token came from staged dispatch map");
            self.defer_attempts(
                staged
                    .affected
                    .into_iter()
                    .map(|(id, attempt)| (id, attempt.attempts))
                    .collect(),
                now,
            )?;
        }
        if !self.can_publish() {
            return Ok(Vec::new());
        }

        let due_deferred: Vec<_> = self
            .deferred_dispatches
            .iter()
            .filter(|(_, dispatch)| now >= dispatch.retry_deadline)
            .map(|(sequence, _)| *sequence)
            .collect();
        let mut actions = Vec::new();
        for sequence in due_deferred {
            let deferred = self
                .deferred_dispatches
                .remove(&sequence)
                .expect("due sequence came from deferred dispatch map");
            actions.extend(self.stage_current_devices(deferred.affected_attempts, now)?);
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
        let scheduled_devices: BTreeSet<_> = self
            .staged_dispatches
            .values()
            .flat_map(|dispatch| dispatch.affected.keys().cloned())
            .chain(
                self.deferred_dispatches
                    .values()
                    .flat_map(|dispatch| dispatch.affected_attempts.keys().cloned()),
            )
            .collect();
        for (id, pending) in due {
            let state = self
                .devices
                .get(&id)
                .expect("due command came from configured device");
            if state.availability != Availability::Online
                || pending.attempts >= self.retry_policy.max_attempts
                || scheduled_devices.contains(&id)
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
            actions.extend(self.stage_dispatch(
                vec![(CommandEntity::Device(id), pending.target)],
                affected,
                now,
            )?);
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
        self.transact_value(now, operation)
    }

    fn transact_value<T, F>(
        &mut self,
        now: MonotonicTime,
        operation: F,
    ) -> Result<T, ReconcileError>
    where
        F: FnOnce(&mut Self, MonotonicTime) -> Result<T, ReconcileError>,
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
        self.transport == TransportStatus::Connected && self.bridge == Availability::Online
    }

    fn validate_claimed_operation(
        &self,
        token: DispatchToken,
        operation_index: usize,
    ) -> Result<(), ReconcileError> {
        let staged = self
            .staged_dispatches
            .get(&token)
            .ok_or(ReconcileError::UnknownDispatchToken(token))?;
        let plan = staged
            .plan
            .ok_or(ReconcileError::UnregisteredDispatchPlan(token))?;
        if plan.next_operation_index != operation_index {
            return Err(ReconcileError::UnexpectedDispatchOperation {
                expected: plan.next_operation_index,
                actual: operation_index,
                operation_count: plan.operation_count,
            });
        }
        Ok(())
    }

    fn command_device(
        &mut self,
        id: &DeviceId,
        attempts: u8,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        if !self.can_publish() {
            return Ok(Vec::new());
        }
        let state = self
            .devices
            .get(id)
            .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
        if state.availability != Availability::Online {
            return Ok(Vec::new());
        }
        let Some(desired) = state.desired else {
            return Ok(Vec::new());
        };
        if target_is_empty(desired) {
            return Ok(Vec::new());
        }
        self.stage_dispatch(
            vec![(CommandEntity::Device(id.clone()), desired)],
            BTreeMap::from([(
                id.clone(),
                StagedAttempt {
                    target: desired,
                    attempts,
                },
            )]),
            now,
        )
    }

    fn stage_current_devices(
        &mut self,
        affected_attempts: BTreeMap<DeviceId, u8>,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        if !self.can_publish() {
            return Ok(Vec::new());
        }
        let mut commands = Vec::new();
        let mut affected = BTreeMap::new();
        for (id, attempts) in affected_attempts {
            let state = self
                .devices
                .get(&id)
                .ok_or_else(|| ReconcileError::UnknownDevice(id.clone()))?;
            let Some(desired) = state.desired else {
                continue;
            };
            if state.availability != Availability::Online
                || targets_in_sync(state.desired, state.observed, state.color_policy)
                || target_is_empty(desired)
            {
                continue;
            }
            commands.push((CommandEntity::Device(id.clone()), desired));
            affected.insert(
                id,
                StagedAttempt {
                    target: desired,
                    attempts,
                },
            );
        }
        self.stage_dispatch(commands, affected, now)
    }

    fn stage_dispatch(
        &mut self,
        commands: Vec<(CommandEntity, DeviceTarget)>,
        affected: BTreeMap<DeviceId, StagedAttempt>,
        now: MonotonicTime,
    ) -> Result<Vec<ReconcileAction>, ReconcileError> {
        if commands.is_empty() || affected.is_empty() {
            return Ok(Vec::new());
        }
        let token_value = self.next_dispatch_token;
        let next_token = token_value
            .checked_add(1)
            .ok_or(ReconcileError::DispatchTokenOverflow)?;
        let token = DispatchToken(token_value);
        let acceptance_deadline = self.retry_policy.dispatch_acceptance_deadline(now, 0)?;
        let actions = commands
            .iter()
            .cloned()
            .map(|(entity, target)| ReconcileAction::Command {
                token,
                entity,
                target,
            })
            .collect();
        self.next_dispatch_token = next_token;
        let replaced = self.staged_dispatches.insert(
            token,
            StagedDispatch {
                affected,
                plan: None,
                acceptance_deadline,
            },
        );
        debug_assert!(replaced.is_none());
        Ok(actions)
    }

    fn cancel_work_for_device(&mut self, id: &DeviceId) -> BTreeSet<DeviceId> {
        let mut canceled = BTreeSet::new();
        self.staged_dispatches.retain(|_, dispatch| {
            if dispatch.affected.contains_key(id) {
                canceled.extend(dispatch.affected.keys().cloned());
                false
            } else {
                true
            }
        });
        self.deferred_dispatches.retain(|_, dispatch| {
            if dispatch.affected_attempts.contains_key(id) {
                canceled.extend(dispatch.affected_attempts.keys().cloned());
                false
            } else {
                true
            }
        });
        canceled
    }

    fn defer_attempts(
        &mut self,
        affected_attempts: BTreeMap<DeviceId, u8>,
        now: MonotonicTime,
    ) -> Result<(), ReconcileError> {
        if affected_attempts.is_empty() {
            return Ok(());
        }
        let retry_deadline = self.retry_policy.dispatch_failure_deadline(now)?;
        let sequence = self.next_deferred_sequence;
        let next_sequence = sequence
            .checked_add(1)
            .ok_or(ReconcileError::DeferredSequenceOverflow)?;
        self.next_deferred_sequence = next_sequence;
        let replaced = self.deferred_dispatches.insert(
            sequence,
            DeferredDispatch {
                affected_attempts,
                retry_deadline,
            },
        );
        debug_assert!(replaced.is_none());
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
                    .is_some_and(|state| state.availability == Availability::Online)
            })
            .cloned()
            .collect();
        if active.is_empty() {
            return Ok(Vec::new());
        }

        let group_has_fields = !target_is_empty(group_target);
        let group_sent = send_group && group_has_fields && active.len() == members.len();
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
            let fallback = if group_sent {
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
        self.stage_dispatch(commands, affected, now)
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
            actions.extend(self.command_device(&id, 1, now)?);
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

fn targets_in_sync(
    desired: Option<DeviceTarget>,
    observed: Option<DeviceTarget>,
    color_policy: ColorComparisonPolicy,
) -> bool {
    let Some(desired) = desired else {
        return true;
    };
    if target_is_empty(desired) {
        return true;
    }
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
                .is_some_and(|observed| colors_in_sync(desired, observed, color_policy))
        })
}

fn colors_in_sync(
    desired: crate::value::Color,
    observed: crate::value::Color,
    policy: ColorComparisonPolicy,
) -> bool {
    if let (Some((desired_hue, desired_saturation)), Some((observed_hue, observed_saturation))) =
        (desired.hs_components(), observed.hs_components())
    {
        if desired_saturation <= policy.achromatic_saturation_threshold
            && observed_saturation <= policy.achromatic_saturation_threshold
        {
            return (desired_saturation - observed_saturation).abs()
                <= policy.achromatic_saturation_threshold.max(0.01);
        }
        let hue_difference = (desired_hue - observed_hue).abs();
        return hue_difference.min(360.0 - hue_difference) <= 0.5
            && (desired_saturation - observed_saturation).abs() <= 0.01;
    }

    let canonical_xy = |color: crate::value::Color| {
        let xy = color
            .hs_components()
            .map(|(hue, saturation)| hs_to_srgb_xy(hue, saturation))
            .or_else(|| color.xy_components())
            .expect("validated color has exactly one representation");
        policy.gamut.map_or(xy, |gamut| project_to_gamut(xy, gamut))
    };
    let desired_xy = canonical_xy(desired);
    let observed_xy = canonical_xy(observed);
    (desired_xy.0 - observed_xy.0).hypot(desired_xy.1 - observed_xy.1) <= policy.xy_tolerance
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

fn subtract(left: (f64, f64), right: (f64, f64)) -> (f64, f64) {
    (left.0 - right.0, left.1 - right.1)
}

fn dot(left: (f64, f64), right: (f64, f64)) -> f64 {
    left.0 * right.0 + left.1 * right.1
}

fn cross(left: (f64, f64), right: (f64, f64)) -> f64 {
    left.0 * right.1 - left.1 * right.0
}

fn project_to_gamut(point: (f64, f64), gamut: ColorGamut) -> (f64, f64) {
    let vertices = [gamut.red, gamut.green, gamut.blue];
    let signs = [
        cross(
            subtract(vertices[1], vertices[0]),
            subtract(point, vertices[0]),
        ),
        cross(
            subtract(vertices[2], vertices[1]),
            subtract(point, vertices[1]),
        ),
        cross(
            subtract(vertices[0], vertices[2]),
            subtract(point, vertices[2]),
        ),
    ];
    if signs.iter().all(|value| *value >= 0.0) || signs.iter().all(|value| *value <= 0.0) {
        return point;
    }

    [
        (vertices[0], vertices[1]),
        (vertices[1], vertices[2]),
        (vertices[2], vertices[0]),
    ]
    .into_iter()
    .map(|(start, end)| closest_point_on_segment(point, start, end))
    .min_by(|left, right| {
        squared_distance(point, *left).total_cmp(&squared_distance(point, *right))
    })
    .expect("triangle has three edges")
}

fn closest_point_on_segment(point: (f64, f64), start: (f64, f64), end: (f64, f64)) -> (f64, f64) {
    let segment = subtract(end, start);
    let position = (dot(subtract(point, start), segment) / dot(segment, segment)).clamp(0.0, 1.0);
    (
        start.0 + segment.0 * position,
        start.1 + segment.1 * position,
    )
}

fn squared_distance(left: (f64, f64), right: (f64, f64)) -> f64 {
    let delta = subtract(left, right);
    dot(delta, delta)
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReconcileError {
    InvalidIdentifier,
    InvalidRetryInterval,
    InvalidRetryAttempts,
    InvalidDispatchAcceptanceTimeout,
    InvalidDispatchFailureBackoff,
    RetryDeadlineOverflow,
    DispatchAcceptanceDeadlineOverflow,
    DispatchFailureDeadlineOverflow,
    DispatchTokenOverflow,
    DeferredSequenceOverflow,
    UnknownDispatchToken(DispatchToken),
    InvalidDispatchOperationCount,
    UnregisteredDispatchPlan(DispatchToken),
    DispatchPlanMismatch(DispatchToken),
    UnexpectedDispatchOperation {
        expected: usize,
        actual: usize,
        operation_count: usize,
    },
    InvalidColorGamut,
    InvalidColorComparisonPolicy,
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
            Self::InvalidDispatchAcceptanceTimeout => formatter
                .write_str("dispatch acceptance timeout must be finite and greater than zero"),
            Self::InvalidDispatchFailureBackoff => formatter
                .write_str("dispatch failure backoff must be finite and greater than zero"),
            Self::RetryDeadlineOverflow => formatter.write_str("retry deadline exceeds monotonic range"),
            Self::DispatchAcceptanceDeadlineOverflow => {
                formatter.write_str("dispatch acceptance deadline exceeds monotonic range")
            }
            Self::DispatchFailureDeadlineOverflow => {
                formatter.write_str("dispatch failure deadline exceeds monotonic range")
            }
            Self::DispatchTokenOverflow => formatter.write_str("dispatch token space exhausted"),
            Self::DeferredSequenceOverflow => {
                formatter.write_str("deferred dispatch sequence space exhausted")
            }
            Self::UnknownDispatchToken(token) => {
                write!(formatter, "unknown or completed dispatch token {}", token.get())
            }
            Self::InvalidDispatchOperationCount => {
                formatter.write_str("dispatch plan must contain at least one operation")
            }
            Self::UnregisteredDispatchPlan(token) => write!(
                formatter,
                "dispatch token {} has no registered adapter plan",
                token.get()
            ),
            Self::DispatchPlanMismatch(token) => write!(
                formatter,
                "dispatch token {} was registered with a different adapter plan",
                token.get()
            ),
            Self::UnexpectedDispatchOperation {
                expected,
                actual,
                operation_count,
            } => write!(
                formatter,
                "dispatch operation {actual} is out of order; expected {expected} of {operation_count}",
            ),
            Self::InvalidColorGamut => {
                formatter.write_str("color gamut points must be finite, normalized, and non-collinear")
            }
            Self::InvalidColorComparisonPolicy => formatter.write_str(
                "color comparison tolerance must be positive and normalized; achromatic threshold must be normalized",
            ),
            Self::MonotonicClockRegressed => formatter.write_str("monotonic clock regressed"),
            Self::DuplicateDevice(id) => write!(formatter, "duplicate device {}", id.as_str()),
            Self::UnknownDevice(id) => write!(formatter, "unknown device {}", id.as_str()),
            Self::DuplicateGroup(id) => write!(formatter, "duplicate group {}", id.as_str()),
            Self::UnknownGroup(id) => write!(formatter, "unknown group {}", id.as_str()),
            Self::EmptyGroup(id) => write!(formatter, "group {} has no members", id.as_str()),
            Self::DuplicateGroupMember => formatter.write_str("group contains duplicate member"),
            Self::DeviceInMultipleGroups(id) => {
                write!(
                    formatter,
                    "device {} belongs to multiple native physical sync groups; higher logical scopes must fan out instead",
                    id.as_str()
                )
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
        Availability, ColorComparisonPolicy, ColorGamut, CommandEntity, DeviceDefinition, DeviceId,
        DispatchAcceptance, DispatchCancellation, DispatchClaim, DispatchRegistrationOutcome,
        DispatchToken, EntityId, GroupDefinition, ReconcileAction, Reconciler, RetryPolicy,
        TransportStatus,
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
        let _ = connect_with_online_bridge(&mut reconciler, 0.0);
        reconciler
    }

    fn connect_with_online_bridge(
        reconciler: &mut Reconciler,
        seconds: f64,
    ) -> Vec<ReconcileAction> {
        let mut actions = reconciler.broker_connected(at(seconds)).unwrap();
        let devices: Vec<_> = reconciler.devices.keys().cloned().collect();
        for device in devices {
            actions.extend(
                reconciler
                    .set_device_availability(&device, Availability::Online, at(seconds))
                    .unwrap(),
            );
        }
        actions.extend(
            reconciler
                .set_bridge_availability(Availability::Online, at(seconds))
                .unwrap(),
        );
        actions
    }

    fn at(seconds: f64) -> MonotonicTime {
        MonotonicTime::from_seconds(seconds).unwrap()
    }

    fn retry_policy() -> RetryPolicy {
        RetryPolicy::new(2.0, 3).unwrap()
    }

    fn accept_operations(
        reconciler: &mut Reconciler,
        token: DispatchToken,
        operation_count: usize,
        now: MonotonicTime,
    ) {
        assert_eq!(
            reconciler
                .register_dispatch_plan(token, now, operation_count, 0)
                .unwrap(),
            DispatchRegistrationOutcome::Registered
        );
        for operation_index in 0..operation_count {
            let DispatchClaim::Ready(permit) = reconciler
                .claim_next_operation(token, operation_index)
                .unwrap()
            else {
                panic!("expected dispatch permit")
            };
            let outcome = permit.accepted(now).unwrap();
            if operation_index + 1 == operation_count {
                assert_eq!(outcome, DispatchAcceptance::BatchAccepted);
            }
        }
    }

    fn fail_first_operation(reconciler: &mut Reconciler, token: DispatchToken, now: MonotonicTime) {
        assert_eq!(
            reconciler.register_dispatch_plan(token, now, 1, 0).unwrap(),
            DispatchRegistrationOutcome::Registered
        );
        let DispatchClaim::Ready(permit) = reconciler.claim_next_operation(token, 0).unwrap()
        else {
            panic!("expected dispatch permit")
        };
        permit.transient_failure(now).unwrap();
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
    fn unknown_availability_remains_suppressed_until_online_is_confirmed() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler
            .set_device_availability(&lamp, Availability::Offline, at(1.0))
            .unwrap();
        reconciler
            .set_device_desired(&lamp, target(0.3), at(1.1))
            .unwrap();

        assert!(
            reconciler
                .set_device_availability(&lamp, Availability::Unknown, at(1.2))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reconciler
                .set_device_availability(&lamp, Availability::Online, at(1.3))
                .unwrap(),
            vec![ReconcileAction::Command {
                token: DispatchToken(1),
                entity: CommandEntity::Device(lamp),
                target: device_target(0.3),
            }]
        );
    }

    #[test]
    fn unknown_availability_blocks_commands() {
        let lamp = id("lamp");
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            retry_policy(),
        )
        .unwrap();
        reconciler.broker_connected(at(0.0)).unwrap();
        reconciler
            .set_bridge_availability(Availability::Online, at(0.1))
            .unwrap();
        assert_eq!(
            reconciler.device_state(&lamp).unwrap().availability(),
            Availability::Unknown
        );
        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.4), at(1.0))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn unknown_availability_invalidates_already_staged_commands() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let actions = reconciler
            .set_device_desired(&lamp, target(0.4), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };

        reconciler
            .set_device_availability(&lamp, Availability::Unknown, at(1.1))
            .unwrap();

        assert!(matches!(
            reconciler.claim_next_operation(token, 0).unwrap(),
            DispatchClaim::Stale
        ));
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
        let _ = connect_with_online_bridge(&mut reconciler, 0.0);

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
        let _ = connect_with_online_bridge(&mut reconciler, 0.0);
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
    fn group_command_waits_until_every_member_is_confirmed_online() {
        let left = id("left");
        let right = id("right");
        let group = entity("group");
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(left.clone(), capabilities()),
                DeviceDefinition::new(right, capabilities()),
            ],
            vec![
                GroupDefinition::new(group, vec![left.clone(), id("right")], capabilities())
                    .unwrap(),
            ],
            retry_policy(),
        )
        .unwrap();
        reconciler.broker_connected(at(0.0)).unwrap();
        reconciler
            .set_device_availability(&left, Availability::Online, at(0.1))
            .unwrap();
        reconciler
            .set_bridge_availability(Availability::Online, at(0.2))
            .unwrap();

        assert_eq!(
            reconciler
                .set_group_desired(&entity("group"), target(0.7), at(0.3))
                .unwrap(),
            vec![ReconcileAction::Command {
                token: DispatchToken(1),
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
            ]
        );
        reconciler
            .set_device_availability(&lamp_b, Availability::Online, at(3.1))
            .unwrap();
        reconciler
            .set_device_availability(&lamp_a, Availability::Online, at(3.1))
            .unwrap();
        assert_eq!(
            reconciler
                .set_bridge_availability(Availability::Online, at(3.1))
                .unwrap(),
            vec![
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
            vec![
                GroupDefinition::new(group.clone(), vec![grouped.clone()], capabilities()).unwrap(),
            ],
            retry_policy(),
        )
        .unwrap();
        let _ = connect_with_online_bridge(&mut reconciler, 0.0);
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
        reconciler
            .set_device_availability(&grouped, Availability::Online, at(1.5))
            .unwrap();
        reconciler
            .set_device_availability(&ungrouped, Availability::Online, at(1.5))
            .unwrap();

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
    fn broker_connect_waits_for_bridge_online_before_sending_desired_state() {
        let lamp = id("lamp");
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            retry_policy(),
        )
        .unwrap();

        let connected = reconciler.broker_connected(at(0.0)).unwrap();
        assert!(connected.contains(&ReconcileAction::Resubscribe));
        assert!(
            connected
                .iter()
                .any(|action| matches!(action, ReconcileAction::RequestState(id) if id == &lamp))
        );
        assert!(
            !connected
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.5), at(0.1))
                .unwrap()
                .is_empty()
        );

        assert!(
            reconciler
                .set_bridge_availability(Availability::Online, at(0.2))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reconciler
                .set_device_availability(&lamp, Availability::Online, at(0.3))
                .unwrap(),
            vec![ReconcileAction::Command {
                token: DispatchToken(1),
                entity: CommandEntity::Device(lamp),
                target: device_target(0.5),
            }]
        );
    }

    #[test]
    fn retained_bridge_online_cannot_race_a_retained_device_offline_report() {
        let lamp = id("lamp");
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            retry_policy(),
        )
        .unwrap();
        reconciler
            .set_device_desired(&lamp, target(0.5), at(0.0))
            .unwrap();
        reconciler.broker_connected(at(0.1)).unwrap();

        assert!(
            reconciler
                .set_bridge_availability(Availability::Online, at(0.2))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_availability(&lamp, Availability::Offline, at(0.3))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn bridge_restart_requires_fresh_device_availability_before_reconcile() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();

        reconciler
            .set_bridge_availability(Availability::Offline, at(1.1))
            .unwrap();
        assert_eq!(
            reconciler.device_state(&lamp).unwrap().availability(),
            Availability::Unknown
        );
        assert!(
            reconciler
                .set_bridge_availability(Availability::Online, at(1.2))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reconciler
                .set_device_availability(&lamp, Availability::Online, at(1.3))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn repeated_bridge_online_report_does_not_duplicate_command() {
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
    fn bounded_refresh_only_reissues_requested_devices() {
        let left = id("left");
        let right = id("right");
        let mut reconciler = connected_reconciler(vec![
            DeviceDefinition::new(left.clone(), capabilities()),
            DeviceDefinition::new(right.clone(), capabilities()),
        ]);
        reconciler
            .set_device_desired(&left, target(0.4), at(1.0))
            .unwrap();
        reconciler
            .set_device_desired(&right, target(0.6), at(1.1))
            .unwrap();

        assert_eq!(
            reconciler
                .force_reconcile_devices(&BTreeSet::from([right.clone()]), at(2.0))
                .unwrap(),
            vec![ReconcileAction::Command {
                token: DispatchToken(3),
                entity: CommandEntity::Device(right),
                target: device_target(0.6),
            }]
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
        accept_operations(&mut reconciler, DispatchToken(1), 1, at(1.0));
        let pending = reconciler
            .device_state(&lamp)
            .unwrap()
            .pending_command()
            .unwrap();
        assert_eq!(pending.attempts(), 1);
        assert_eq!(pending.deadline().seconds(), 3.5);

        assert!(reconciler.retry_due(at(3.499)).unwrap().is_empty());
        assert_eq!(
            reconciler.retry_due(at(3.5)).unwrap(),
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
        accept_operations(&mut reconciler, DispatchToken(2), 1, at(3.5));
        assert_eq!(
            reconciler
                .observe(&lamp, device_target(0.2), at(3.6))
                .unwrap(),
            Vec::new()
        );
        assert_eq!(
            reconciler.retry_due(at(6.0)).unwrap(),
            vec![ReconcileAction::Command {
                token: DispatchToken(3),
                entity: CommandEntity::Device(lamp.clone()),
                target: device_target(0.5),
            }]
        );
        accept_operations(&mut reconciler, DispatchToken(3), 1, at(6.0));
        assert!(reconciler.retry_due(at(8.5)).unwrap().is_empty());
        let pending = reconciler
            .device_state(&lamp)
            .unwrap()
            .pending_command()
            .unwrap();
        assert_eq!(pending.attempts(), 3);
        assert_eq!(reconciler.next_deadline(), None);
        assert!(!reconciler.device_state(&lamp).unwrap().in_sync());
        assert!(
            reconciler
                .set_device_desired(&lamp, target(0.5), at(8.6))
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
        accept_operations(&mut reconciler, DispatchToken(1), 1, at(1.0));

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
        accept_operations(&mut reconciler, DispatchToken(1), 1, at(1.0));

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
        connect_with_online_bridge(&mut reconciler, 0.0);
        let initial = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = initial[0] else {
            unreachable!()
        };
        accept_operations(&mut reconciler, token, 1, at(1.0));
        let retry = reconciler.retry_due(at(2.5)).unwrap();
        let ReconcileAction::Command { token, .. } = retry[0] else {
            unreachable!()
        };
        accept_operations(&mut reconciler, token, 1, at(2.5));
        assert!(reconciler.retry_due(at(3.5)).unwrap().is_empty());

        reconciler.broker_disconnected(at(4.0)).unwrap();
        let reconnect = reconciler.broker_connected(at(5.0)).unwrap();
        assert!(
            !reconnect
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
        let recovered_bridge = reconciler
            .set_device_availability(&lamp, Availability::Online, at(5.0))
            .and_then(|_| reconciler.set_bridge_availability(Availability::Online, at(5.0)))
            .unwrap();
        assert!(
            recovered_bridge
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
        let token = recovered_bridge
            .iter()
            .find_map(|action| match action {
                ReconcileAction::Command { token, .. } => Some(*token),
                _ => None,
            })
            .unwrap();
        accept_operations(&mut reconciler, token, 1, at(5.0));
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
        accept_operations(&mut reconciler, token, 1, at(5.2));
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
    fn repeated_connected_notification_is_idempotent_but_reconnect_reconciles() {
        let lamp = id("lamp");
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            retry_policy(),
        )
        .unwrap();
        let initial = reconciler.broker_connected(at(0.0)).unwrap();
        assert!(initial.contains(&ReconcileAction::Resubscribe));
        reconciler
            .set_device_availability(&lamp, Availability::Online, at(0.1))
            .unwrap();
        reconciler
            .set_bridge_availability(Availability::Online, at(0.1))
            .unwrap();
        let staged = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = staged[0] else {
            unreachable!()
        };

        assert!(reconciler.broker_connected(at(1.1)).unwrap().is_empty());
        assert!(reconciler.is_dispatch_token_valid(token));

        reconciler.broker_disconnected(at(1.2)).unwrap();
        let reconnect = reconciler.broker_connected(at(1.3)).unwrap();
        assert!(reconnect.contains(&ReconcileAction::Resubscribe));
        assert!(
            reconnect
                .iter()
                .any(|action| matches!(action, ReconcileAction::RequestState(id) if id == &lamp))
        );
        assert!(
            !reconnect
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
        assert!(
            reconciler
                .set_bridge_availability(Availability::Online, at(1.4))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_availability(&lamp, Availability::Online, at(1.5))
                .unwrap()
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
    }

    #[test]
    fn reconnect_does_not_stage_empty_target_for_non_controllable_device() {
        let sensor = id("sensor");
        let no_controls = Capabilities {
            on_off: false,
            dimming: false,
            color_temperature: None,
            color_xy: false,
            color_hs: false,
            input: false,
            occupancy: true,
            temperature: true,
            power_metering: false,
        };
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(sensor.clone(), no_controls)],
            Vec::new(),
            retry_policy(),
        )
        .unwrap();

        assert!(
            reconciler
                .set_device_desired(&sensor, target(0.5), at(1.0))
                .unwrap()
                .is_empty()
        );
        let connected = reconciler.broker_connected(at(2.0)).unwrap();
        assert!(
            !connected
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
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
        for (acceptance, backoff) in [
            (0.0, 1.0),
            (-1.0, 1.0),
            (f64::NAN, 1.0),
            (1.0, 0.0),
            (1.0, f64::INFINITY),
        ] {
            assert!(
                retry_policy()
                    .with_dispatch_timing(acceptance, backoff)
                    .is_err()
            );
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
        connect_with_online_bridge(&mut reconciler, 0.0);
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
        accept_operations(&mut reconciler, DispatchToken(1), 3, at(1.0));
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
        connect_with_online_bridge(&mut reconciler, 0.0);

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

        accept_operations(&mut reconciler, token, 1, at(1.1));
        let pending = reconciler
            .device_state(&lamp)
            .unwrap()
            .pending_command()
            .unwrap();
        assert_eq!(pending.attempts(), 1);
        assert_eq!(pending.deadline(), at(3.6));
        assert_eq!(pending.target(), device_target(0.5));

        assert!(matches!(
            reconciler.claim_next_operation(token, 0).unwrap(),
            DispatchClaim::Stale
        ));
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

        fail_first_operation(&mut reconciler, first_token, at(1.1));
        assert!(reconciler.retry_due(at(1.599_999)).unwrap().is_empty());
        let retry = reconciler.retry_due(at(1.6)).unwrap();
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

        accept_operations(&mut reconciler, retry_token, 1, at(1.7));
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
    fn failed_correlation_retry_stays_deferred_until_exact_local_backoff_boundary() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let initial = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command {
            token: initial_token,
            ..
        } = initial[0]
        else {
            panic!("expected initial command")
        };
        accept_operations(&mut reconciler, initial_token, 1, at(1.0));

        let correlation_retry = reconciler.retry_due(at(3.5)).unwrap();
        let ReconcileAction::Command {
            token: retry_token, ..
        } = correlation_retry[0]
        else {
            panic!("expected correlation retry")
        };
        fail_first_operation(&mut reconciler, retry_token, at(3.6));

        assert!(reconciler.retry_due(at(3.7)).unwrap().is_empty());
        assert!(reconciler.retry_due(at(4.099_999)).unwrap().is_empty());
        let retry = reconciler.retry_due(at(4.1)).unwrap();
        assert_eq!(retry.len(), 1);
        assert!(reconciler.retry_due(at(4.1)).unwrap().is_empty());
    }

    #[test]
    fn repeated_local_dispatch_failures_never_exhaust_on_wire_attempts() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let mut actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();

        let mut current = 1.0;
        for _ in 1..=20 {
            let ReconcileAction::Command { token, .. } = actions[0] else {
                unreachable!()
            };
            fail_first_operation(&mut reconciler, token, at(current + 0.01));
            assert!(
                reconciler
                    .retry_due(at(current + 0.509_999))
                    .unwrap()
                    .is_empty()
            );
            current += 0.51;
            actions = reconciler.retry_due(at(current)).unwrap();
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
        accept_operations(&mut reconciler, token, 1, at(current + 0.01));
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
        connect_with_online_bridge(&mut reconciler, 0.0);

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

        accept_operations(
            &mut reconciler,
            *tokens.first().unwrap(),
            actions.len(),
            at(1.1),
        );
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
        assert!(matches!(
            reconciler.claim_next_operation(token, 0).unwrap(),
            DispatchClaim::Stale
        ));
        assert!(
            !reconciler
                .broker_connected(at(1.3))
                .unwrap()
                .iter()
                .any(|action| matches!(action, ReconcileAction::Command { .. }))
        );
        assert!(
            reconciler
                .set_bridge_availability(Availability::Online, at(1.4))
                .unwrap()
                .is_empty()
        );
        assert!(
            reconciler
                .set_device_availability(&lamp, Availability::Online, at(1.5))
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
            ColorComparisonPolicy::default(),
        ));
        assert!(!super::colors_in_sync(
            Color::hs(0.0, 1.0).unwrap(),
            Color::xy(0.15, 0.06).unwrap(),
            ColorComparisonPolicy::default(),
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

    #[test]
    fn staged_acceptance_timeout_expires_then_restages_at_exact_backoff_boundary() {
        let lamp = id("lamp");
        let policy = retry_policy().with_dispatch_timing(0.5, 0.25).unwrap();
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            policy,
        )
        .unwrap();
        connect_with_online_bridge(&mut reconciler, 0.0);
        let first = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token: old, .. } = first[0] else {
            unreachable!()
        };
        assert_eq!(
            reconciler
                .register_dispatch_plan(old, at(1.0), 1, 0)
                .unwrap(),
            DispatchRegistrationOutcome::Registered
        );
        assert!(reconciler.is_dispatch_token_valid(old));

        assert!(reconciler.retry_due(at(1.5)).unwrap().is_empty());
        assert!(!reconciler.is_dispatch_token_valid(old));
        assert!(reconciler.retry_due(at(1.749_999)).unwrap().is_empty());
        let restaged = reconciler.retry_due(at(1.75)).unwrap();
        let ReconcileAction::Command { token: new, .. } = restaged[0] else {
            unreachable!()
        };
        assert_ne!(old, new);
        assert!(reconciler.is_dispatch_token_valid(new));
        assert!(reconciler.device_state(&lamp).unwrap().pending.is_none());
    }

    #[test]
    fn unregistered_staged_dispatch_expires_then_retries_at_exact_boundaries() {
        let lamp = id("lamp");
        let policy = retry_policy().with_dispatch_timing(0.5, 0.25).unwrap();
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            policy,
        )
        .unwrap();
        connect_with_online_bridge(&mut reconciler, 0.0);
        let first = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token: old, .. } = first[0] else {
            unreachable!()
        };

        assert!(reconciler.retry_due(at(1.499_999)).unwrap().is_empty());
        assert!(reconciler.is_dispatch_token_valid(old));
        assert!(reconciler.retry_due(at(1.5)).unwrap().is_empty());
        assert!(!reconciler.is_dispatch_token_valid(old));
        assert!(reconciler.retry_due(at(1.749_999)).unwrap().is_empty());
        let retry = reconciler.retry_due(at(1.75)).unwrap();
        let ReconcileAction::Command { token: new, .. } = retry[0] else {
            unreachable!()
        };
        assert_ne!(new, old);
    }

    #[test]
    fn accepted_transition_waits_for_completion_and_retry_interval() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let mut desired = target(0.5);
        desired.transition_ms = Some(60_000);
        let actions = reconciler
            .set_device_desired(&lamp, desired, at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        accept_operations(&mut reconciler, token, 1, at(1.0));

        assert_eq!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .unwrap()
                .deadline(),
            at(63.0)
        );
    }

    #[test]
    fn intermediate_fade_observations_do_not_restart_transition_before_exact_deadline() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let mut desired = target(0.5);
        desired.transition_ms = Some(60_000);
        let actions = reconciler
            .set_device_desired(&lamp, desired, at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        accept_operations(&mut reconciler, token, 1, at(1.0));

        let intermediate = DeviceTarget {
            on: Some(true),
            brightness: Some(Brightness::new(0.25).unwrap()),
            color_temperature: Some(Kelvin::new(3000.0).unwrap()),
            color: None,
            transition_ms: None,
        };
        assert!(
            reconciler
                .observe(&lamp, intermediate, at(31.0))
                .unwrap()
                .is_empty()
        );
        assert!(reconciler.retry_due(at(62.999_999)).unwrap().is_empty());
        assert_eq!(reconciler.retry_due(at(63.0)).unwrap().len(), 1);
    }

    #[test]
    fn accepted_transition_deadline_saturates_at_monotonic_range_limit() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let mut desired = target(0.5);
        desired.transition_ms = Some(60_000);
        let actions = reconciler
            .set_device_desired(&lamp, desired, at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        reconciler
            .register_dispatch_plan(token, at(1.0), 1, 0)
            .unwrap();
        let DispatchClaim::Ready(permit) = reconciler.claim_next_operation(token, 0).unwrap()
        else {
            unreachable!()
        };

        assert_eq!(
            permit.accepted(at(f64::MAX)).unwrap(),
            DispatchAcceptance::BatchAccepted
        );
        assert_eq!(
            reconciler
                .device_state(&lamp)
                .unwrap()
                .pending_command()
                .unwrap()
                .deadline(),
            at(f64::MAX)
        );
    }

    #[test]
    fn registered_delayed_plan_gets_its_full_offset_plus_acceptance_margin() {
        let lamp = id("lamp");
        let policy = retry_policy().with_dispatch_timing(0.5, 0.25).unwrap();
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            policy,
        )
        .unwrap();
        connect_with_online_bridge(&mut reconciler, 0.0);
        let actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };

        assert_eq!(
            reconciler
                .register_dispatch_plan(token, at(1.0), 2, 750)
                .unwrap(),
            DispatchRegistrationOutcome::Registered
        );
        assert!(reconciler.retry_due(at(1.5)).unwrap().is_empty());
        assert!(reconciler.is_dispatch_token_valid(token));
        assert!(reconciler.retry_due(at(2.249_999)).unwrap().is_empty());
        assert!(reconciler.retry_due(at(2.25)).unwrap().is_empty());
        assert!(!reconciler.is_dispatch_token_valid(token));
        assert!(reconciler.retry_due(at(2.499_999)).unwrap().is_empty());
        assert_eq!(reconciler.retry_due(at(2.5)).unwrap().len(), 1);
    }

    #[test]
    fn dispatch_plan_deadline_overflow_is_atomic() {
        let lamp = id("lamp");
        let policy = retry_policy().with_dispatch_timing(0.5, 0.25).unwrap();
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            policy,
        )
        .unwrap();
        connect_with_online_bridge(&mut reconciler, 0.0);
        let actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        let before = reconciler.clone();

        assert_eq!(
            reconciler.register_dispatch_plan(token, at(f64::MAX), 1, 0),
            Err(super::ReconcileError::DispatchAcceptanceDeadlineOverflow)
        );
        assert_eq!(reconciler, before);
    }

    #[test]
    fn borrowed_permits_track_each_operation_and_only_finalize_the_complete_batch() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        assert_eq!(
            reconciler
                .register_dispatch_plan(token, at(1.0), 2, 750)
                .unwrap(),
            DispatchRegistrationOutcome::Registered
        );

        let DispatchClaim::Ready(permit) = reconciler.claim_next_operation(token, 0).unwrap()
        else {
            panic!("expected first permit")
        };
        assert_eq!(
            permit.accepted(at(1.1)).unwrap(),
            DispatchAcceptance::OperationAccepted { remaining: 1 }
        );
        assert!(reconciler.device_state(&lamp).unwrap().pending.is_none());
        assert!(matches!(
            reconciler.claim_next_operation(token, 0).unwrap(),
            DispatchClaim::AlreadyAccepted
        ));

        let DispatchClaim::Ready(permit) = reconciler.claim_next_operation(token, 1).unwrap()
        else {
            panic!("expected second permit")
        };
        assert_eq!(
            permit.accepted(at(1.75)).unwrap(),
            DispatchAcceptance::BatchAccepted
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
        assert!(matches!(
            reconciler.claim_next_operation(token, 1).unwrap(),
            DispatchClaim::Stale
        ));
        assert_eq!(
            reconciler.cancel_dispatch(token, at(1.8)).unwrap(),
            DispatchCancellation::Stale
        );
    }

    #[test]
    fn desired_change_between_delayed_operations_makes_the_next_claim_benignly_stale() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        reconciler
            .register_dispatch_plan(token, at(1.0), 2, 750)
            .unwrap();
        let DispatchClaim::Ready(permit) = reconciler.claim_next_operation(token, 0).unwrap()
        else {
            unreachable!()
        };
        permit.accepted(at(1.05)).unwrap();

        let replacement = reconciler
            .set_device_desired(&lamp, target(0.8), at(1.1))
            .unwrap();
        assert_eq!(replacement.len(), 1);
        assert!(matches!(
            reconciler.claim_next_operation(token, 1).unwrap(),
            DispatchClaim::Stale
        ));
    }

    #[test]
    fn transient_failure_after_partial_acceptance_defers_the_complete_batch() {
        let left = id("left");
        let right = id("right");
        let group = entity("room");
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(left.clone(), capabilities()),
                DeviceDefinition::new(right.clone(), capabilities()),
            ],
            vec![
                GroupDefinition::new(
                    group.clone(),
                    vec![left.clone(), right.clone()],
                    capabilities(),
                )
                .unwrap(),
            ],
            retry_policy(),
        )
        .unwrap();
        connect_with_online_bridge(&mut reconciler, 0.0);
        let actions = reconciler
            .set_group_desired(&group, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        reconciler
            .register_dispatch_plan(token, at(1.0), 2, 0)
            .unwrap();
        let DispatchClaim::Ready(first) = reconciler.claim_next_operation(token, 0).unwrap() else {
            unreachable!()
        };
        assert_eq!(
            first.accepted(at(1.05)).unwrap(),
            DispatchAcceptance::OperationAccepted { remaining: 1 }
        );
        let DispatchClaim::Ready(second) = reconciler.claim_next_operation(token, 1).unwrap()
        else {
            unreachable!()
        };
        second.transient_failure(at(1.1)).unwrap();
        assert!(reconciler.device_state(&left).unwrap().pending.is_none());
        assert!(reconciler.device_state(&right).unwrap().pending.is_none());
        assert!(reconciler.retry_due(at(1.599_999)).unwrap().is_empty());
        let restaged = reconciler.retry_due(at(1.6)).unwrap();
        assert_eq!(restaged.len(), 2);
        let tokens: BTreeSet<_> = restaged
            .iter()
            .filter_map(|action| match action {
                ReconcileAction::Command { token, .. } => Some(*token),
                _ => None,
            })
            .collect();
        assert_eq!(tokens.len(), 1);
    }

    #[test]
    fn claimed_permanent_failure_cancels_without_retry() {
        let lamp = id("lamp");
        let mut reconciler =
            connected_reconciler(vec![DeviceDefinition::new(lamp.clone(), capabilities())]);
        let actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        reconciler
            .register_dispatch_plan(token, at(1.0), 1, 0)
            .unwrap();
        let DispatchClaim::Ready(permit) = reconciler.claim_next_operation(token, 0).unwrap()
        else {
            unreachable!()
        };
        permit.permanent_failure(at(1.1)).unwrap();

        assert!(matches!(
            reconciler.claim_next_operation(token, 0).unwrap(),
            DispatchClaim::Stale
        ));
        assert!(reconciler.retry_due(at(100.0)).unwrap().is_empty());
    }

    #[test]
    fn timeout_and_duplicate_registration_races_are_typed_but_bad_order_is_an_error() {
        let lamp = id("lamp");
        let policy = retry_policy().with_dispatch_timing(0.5, 0.25).unwrap();
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            policy,
        )
        .unwrap();
        connect_with_online_bridge(&mut reconciler, 0.0);
        let actions = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token, .. } = actions[0] else {
            unreachable!()
        };
        assert!(matches!(
            reconciler.claim_next_operation(token, 0),
            Err(super::ReconcileError::UnregisteredDispatchPlan(unregistered))
                if unregistered == token
        ));
        let before_invalid_registration = reconciler.clone();
        assert_eq!(
            reconciler.register_dispatch_plan(token, at(1.0), 0, 0),
            Err(super::ReconcileError::InvalidDispatchOperationCount)
        );
        assert_eq!(reconciler, before_invalid_registration);
        assert_eq!(
            reconciler
                .register_dispatch_plan(token, at(1.0), 2, 0)
                .unwrap(),
            DispatchRegistrationOutcome::Registered
        );
        assert_eq!(
            reconciler
                .register_dispatch_plan(token, at(1.0), 2, 0)
                .unwrap(),
            DispatchRegistrationOutcome::AlreadyRegistered
        );
        let before_mismatch = reconciler.clone();
        assert_eq!(
            reconciler.register_dispatch_plan(token, at(1.0), 3, 0),
            Err(super::ReconcileError::DispatchPlanMismatch(token))
        );
        assert_eq!(reconciler, before_mismatch);
        assert!(matches!(
            reconciler.claim_next_operation(token, 1),
            Err(super::ReconcileError::UnexpectedDispatchOperation {
                expected: 0,
                actual: 1,
                operation_count: 2,
            })
        ));
        assert!(reconciler.retry_due(at(1.5)).unwrap().is_empty());
        assert!(matches!(
            reconciler.claim_next_operation(token, 0).unwrap(),
            DispatchClaim::Stale
        ));
        assert_eq!(
            reconciler
                .register_dispatch_plan(token, at(1.0), 2, 0)
                .unwrap(),
            DispatchRegistrationOutcome::Stale
        );
        assert_eq!(
            reconciler.cancel_dispatch(token, at(1.5)).unwrap(),
            DispatchCancellation::Stale
        );
    }

    #[test]
    fn transient_failure_waits_for_backoff_and_permanent_cancel_does_not_retry() {
        let lamp = id("lamp");
        let policy = retry_policy().with_dispatch_timing(0.5, 0.25).unwrap();
        let mut reconciler = Reconciler::new(
            vec![DeviceDefinition::new(lamp.clone(), capabilities())],
            Vec::new(),
            policy,
        )
        .unwrap();
        connect_with_online_bridge(&mut reconciler, 0.0);
        let first = reconciler
            .set_device_desired(&lamp, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command { token: old, .. } = first[0] else {
            unreachable!()
        };

        fail_first_operation(&mut reconciler, old, at(1.1));
        assert!(!reconciler.is_dispatch_token_valid(old));
        assert!(reconciler.retry_due(at(1.349_999)).unwrap().is_empty());
        let retry = reconciler.retry_due(at(1.35)).unwrap();
        let ReconcileAction::Command { token: retry, .. } = retry[0] else {
            unreachable!()
        };
        assert_eq!(
            reconciler.cancel_dispatch(retry, at(1.36)).unwrap(),
            DispatchCancellation::Cancelled
        );
        assert!(reconciler.retry_due(at(100.0)).unwrap().is_empty());
        assert!(reconciler.device_state(&lamp).unwrap().pending.is_none());
    }

    #[test]
    fn changing_one_member_cancels_group_token_and_restages_complete_current_batch() {
        let left = id("left");
        let right = id("right");
        let group = entity("room");
        let mut reconciler = Reconciler::new(
            vec![
                DeviceDefinition::new(left.clone(), capabilities()),
                DeviceDefinition::new(right.clone(), capabilities()),
            ],
            vec![
                GroupDefinition::new(
                    group.clone(),
                    vec![left.clone(), right.clone()],
                    capabilities(),
                )
                .unwrap(),
            ],
            retry_policy(),
        )
        .unwrap();
        connect_with_online_bridge(&mut reconciler, 0.0);
        let group_batch = reconciler
            .set_group_desired(&group, target(0.5), at(1.0))
            .unwrap();
        let ReconcileAction::Command {
            token: group_token, ..
        } = group_batch[0]
        else {
            unreachable!()
        };

        let restaged = reconciler
            .set_device_desired(&left, target(0.8), at(1.1))
            .unwrap();
        assert!(!reconciler.is_dispatch_token_valid(group_token));
        assert_eq!(restaged.len(), 2);
        let ReconcileAction::Command {
            token: current_token,
            ..
        } = restaged[0]
        else {
            unreachable!()
        };
        assert!(restaged.iter().all(|action| matches!(
            action,
            ReconcileAction::Command { token, .. } if *token == current_token
        )));
        assert!(restaged.iter().any(|action| matches!(
            action,
            ReconcileAction::Command { entity: CommandEntity::Device(id), target, .. }
                if id == &left && *target == device_target(0.8)
        )));
        assert!(restaged.iter().any(|action| matches!(
            action,
            ReconcileAction::Command { entity: CommandEntity::Device(id), target, .. }
                if id == &right && *target == device_target(0.5)
        )));
        accept_operations(&mut reconciler, current_token, restaged.len(), at(1.2));
        assert!(reconciler.device_state(&left).unwrap().pending.is_some());
        assert!(reconciler.device_state(&right).unwrap().pending.is_some());
    }

    #[test]
    fn color_policy_handles_gamut_endpoints_achromatic_hue_and_rejects_malformed_values() {
        let hue_gamut = ColorGamut::new((0.6915, 0.3083), (0.17, 0.7), (0.1532, 0.0475)).unwrap();
        let policy = ColorComparisonPolicy::new(Some(hue_gamut), 0.06, 0.02).unwrap();
        assert!(super::colors_in_sync(
            Color::hs(0.0, 1.0).unwrap(),
            Color::xy(0.6915, 0.3083).unwrap(),
            policy,
        ));
        assert!(!super::colors_in_sync(
            Color::hs(0.0, 1.0).unwrap(),
            Color::xy(0.1532, 0.0475).unwrap(),
            policy,
        ));
        assert!(super::colors_in_sync(
            Color::hs(5.0, 0.005).unwrap(),
            Color::hs(275.0, 0.006).unwrap(),
            policy,
        ));

        assert!(ColorGamut::new((0.1, 0.1), (0.2, 0.2), (0.3, 0.3)).is_err());
        assert!(ColorGamut::new((f64::NAN, 0.1), (0.2, 0.3), (0.4, 0.5)).is_err());
        assert!(ColorComparisonPolicy::new(None, 0.0, 0.02).is_err());
        assert!(ColorComparisonPolicy::new(None, 0.03, 1.1).is_err());
    }
}
