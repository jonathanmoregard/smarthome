use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use house_automation_core::{
    curve::{CircadianCurve, TimeOfDay},
    input::{Action, ClickClassifier, Direction, Gesture, Mapping, ScopeTarget},
    overlay::{OverlayDuration, OverlayEffect, OverlayId, OverlaySet},
    reconcile::{
        Availability, DeviceId, DispatchAcceptance, DispatchClaim, EntityId, ReconcileAction,
        Reconciler,
    },
    state::{
        AutomationState, ControlId, ControlState, CurveToggleOutcome, LocalDate, MonotonicTime,
        Scope, ScopeMembership, ScopeState,
    },
    value::{Capabilities, KelvinRange, LightTarget},
};

use crate::{
    config::{
        CircadianSettings, MqttSettings, ReconciliationTiming, RuntimeConfigParts, ValidatedConfig,
        WholeHourSettings,
    },
    health::HealthState,
    mqtt::{MqttTransport, RumqttTransport, TransportEvent, load_credentials, status_topic},
    persistence::{PersistenceError, SqliteStateStore},
    scheduler::{Clock, Scheduler, TokioClock},
    zigbee2mqtt::{AdapterOperation, InboundEvent, PlanEpoch, Zigbee2MqttAdapter},
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RuntimeInstant {
    pub local_date: LocalDate,
    pub local_time: TimeOfDay,
    pub monotonic: MonotonicTime,
}

impl RuntimeInstant {
    pub fn new(
        local_date: LocalDate,
        hour: u8,
        minute: u8,
        second: u8,
        monotonic: MonotonicTime,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            local_date,
            local_time: TimeOfDay::from_hms(hour, minute, second)
                .map_err(|_| RuntimeError::InvalidInstant)?,
            monotonic,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionSummary {
    pub affected_owner_count: usize,
    pub acknowledged_owner_count: usize,
    pub recomputed_devices: usize,
    pub durable_state_changed: bool,
}

#[derive(Debug, Clone)]
struct DeviceRuntime {
    membership: ScopeMembership,
    capabilities: Capabilities,
    owner: Scope,
}

#[derive(Debug, Clone)]
struct GroupRuntime {
    id: EntityId,
    members: Vec<DeviceId>,
    shared_owner: Option<Scope>,
    has_group_color_temperature: bool,
}

#[derive(Clone)]
pub struct HouseEngine {
    state: AutomationState,
    startup_state_changed: bool,
    owners: BTreeSet<Scope>,
    devices: BTreeMap<DeviceId, DeviceRuntime>,
    device_aliases: BTreeMap<DeviceId, DeviceId>,
    curves: BTreeMap<Scope, CircadianCurve>,
    controls: BTreeMap<ControlId, Mapping>,
    overlays: BTreeMap<Scope, OverlaySet>,
    classifier: ClickClassifier,
    acknowledgement: house_automation_core::overlay::AcknowledgementSettings,
    circadian: CircadianSettings,
    whole_hour: WholeHourSettings,
    reconciliation_timing: ReconciliationTiming,
    reconciler: Reconciler,
    adapter: Zigbee2MqttAdapter,
    groups: Vec<GroupRuntime>,
    mqtt: MqttSettings,
    last_targets: BTreeMap<DeviceId, LightTarget>,
    last_reconciled_at: BTreeMap<DeviceId, MonotonicTime>,
    pending_actions: Vec<ReconcileAction>,
}

impl HouseEngine {
    pub fn initialize(
        parts: RuntimeConfigParts,
        persisted: AutomationState,
        now: RuntimeInstant,
    ) -> Result<Self, RuntimeError> {
        let RuntimeConfigParts {
            mqtt,
            input,
            circadian,
            acknowledgement,
            acknowledgement_duration_ms: _,
            whole_hour,
            retry_policy,
            reconciliation_timing,
            health: _,
            curves: configured_curves,
            scopes,
            devices: configured_devices,
            groups: configured_groups,
            controls: configured_controls,
            zigbee2mqtt,
        } = parts;

        let configured_scopes: BTreeSet<_> = scopes.iter().map(|item| item.scope.clone()).collect();
        let persisted_snapshot = persisted.snapshot();
        let mut state = normalize_state(persisted, &configured_scopes, &configured_controls)?;
        let normalized_changed = persisted_snapshot != state.snapshot();
        let before_reset = state.snapshot();
        let reset = state.reset_circadian_if_due(
            now.local_date,
            now.local_time,
            circadian.daily_reset_time,
            now.monotonic,
            circadian.convergence_duration,
        )?;
        let startup_state_changed =
            normalized_changed || before_reset != state.snapshot() || reset.durable_state_changed();

        let mut curves = BTreeMap::new();
        for configured_scope in &scopes {
            let curve = configured_curves
                .get(&configured_scope.curve)
                .ok_or(RuntimeError::InvalidTopology("scope curve is missing"))?;
            curves.insert(configured_scope.scope.clone(), curve.clone());
        }

        let mut devices = BTreeMap::new();
        let mut device_aliases = BTreeMap::new();
        let mut definitions = Vec::new();
        for device in configured_devices {
            for alias in &device.aliases {
                device_aliases.insert(alias.clone(), device.id.clone());
            }
            let capabilities = device.definition.capabilities();
            definitions.push(device.definition);
            if !capabilities.on_off {
                continue;
            }
            let owner = resolve_owner(&configured_scopes, &device.membership)?;
            devices.insert(
                device.id,
                DeviceRuntime {
                    membership: device.membership,
                    capabilities,
                    owner,
                },
            );
        }
        if devices.is_empty() {
            return Err(RuntimeError::InvalidTopology(
                "at least one controllable device is required",
            ));
        }
        let owners: BTreeSet<_> = devices
            .values()
            .map(|device| device.owner.clone())
            .collect();
        let overlays = owners
            .iter()
            .cloned()
            .map(|scope| (scope, OverlaySet::new()))
            .collect();

        let mut groups = Vec::new();
        let mut group_definitions = Vec::new();
        for group in configured_groups {
            let shared_owner = group
                .members
                .first()
                .and_then(|first| devices.get(first))
                .map(|device| device.owner.clone())
                .filter(|owner| {
                    group.members.iter().all(|member| {
                        devices
                            .get(member)
                            .is_some_and(|device| &device.owner == owner)
                    })
                });
            groups.push(GroupRuntime {
                id: group.id,
                members: group.members,
                shared_owner,
                has_group_color_temperature: group.mired_range.is_some(),
            });
            group_definitions.push(group.definition);
        }
        let reconciler = Reconciler::new(definitions, group_definitions, retry_policy)?;
        let controls = configured_controls
            .into_iter()
            .map(|control| (control.id, control.mapping))
            .collect();

        Ok(Self {
            state,
            startup_state_changed,
            owners,
            devices,
            device_aliases,
            curves,
            controls,
            overlays,
            classifier: ClickClassifier::new(
                input.double_click_window,
                input.ambiguous_hold_window,
            )?,
            acknowledgement,
            circadian,
            whole_hour,
            reconciliation_timing,
            reconciler,
            adapter: zigbee2mqtt,
            groups,
            mqtt,
            last_targets: BTreeMap::new(),
            last_reconciled_at: BTreeMap::new(),
            pending_actions: Vec::new(),
        })
    }

    pub fn state(&self) -> &AutomationState {
        &self.state
    }

    pub fn startup_state_changed(&self) -> bool {
        self.startup_state_changed
    }

    pub fn owner_scope(&self, device: &DeviceId) -> Result<&Scope, RuntimeError> {
        let device = self.device_aliases.get(device).unwrap_or(device);
        self.devices
            .get(device)
            .map(|device| &device.owner)
            .ok_or(RuntimeError::UnknownDevice)
    }

    pub fn target(&self, device: &DeviceId) -> Option<LightTarget> {
        let device = self.device_aliases.get(device).unwrap_or(device);
        self.last_targets.get(device).copied()
    }

    pub fn owner_states(
        &self,
    ) -> impl Iterator<Item = (&Scope, &house_automation_core::state::ScopeState)> {
        self.owners.iter().map(|owner| {
            (
                owner,
                self.state
                    .scope_state(owner)
                    .expect("owners are normalized"),
            )
        })
    }

    pub fn apply_gesture_for_scope(
        &mut self,
        gesture: Gesture,
        target: &Scope,
        now: RuntimeInstant,
    ) -> Result<ActionSummary, RuntimeError> {
        let action = self
            .controls
            .values()
            .find_map(|mapping| mapping.entry(gesture).map(|entry| entry.action()))
            .ok_or(RuntimeError::UnmappedGesture)?;
        self.apply_action(action, target, now)
    }

    pub fn handle_input(
        &mut self,
        control: ControlId,
        event: house_automation_core::input::RawInputEvent,
        now: RuntimeInstant,
    ) -> Result<Vec<ActionSummary>, RuntimeError> {
        let classified = self.classifier.ingest(control, event, now.monotonic)?;
        self.apply_classified(classified, now)
    }

    pub fn start_whole_hour_overlay(&mut self, now: RuntimeInstant) -> Result<usize, RuntimeError> {
        let id = OverlayId::new("whole-hour")?;
        let effect = OverlayEffect::brightness_delta(self.whole_hour.brightness_delta)?;
        let duration = OverlayDuration::from_seconds(self.whole_hour.duration_ms as f64 / 1000.0)?;
        for owner in &self.owners {
            self.overlays
                .get_mut(owner)
                .expect("owner overlay exists")
                .insert(
                    id.clone(),
                    effect,
                    self.whole_hour.priority,
                    now.monotonic,
                    duration,
                )?;
        }
        tracing::info!(
            source = "scheduler",
            action = "start",
            overlay = "whole-hour",
            affected_owner_count = self.owners.len(),
            "started temporary lighting overlay"
        );
        let (actions, count) = self.recompute_desired(now)?;
        self.queue_reconcile_actions(actions, now)?;
        Ok(count)
    }

    pub fn flush_input(&mut self, now: RuntimeInstant) -> Result<Vec<ActionSummary>, RuntimeError> {
        let classified = self.classifier.flush_due(now.monotonic)?;
        self.apply_classified(classified, now)
    }

    fn apply_classified(
        &mut self,
        classified: Vec<(ControlId, Gesture)>,
        now: RuntimeInstant,
    ) -> Result<Vec<ActionSummary>, RuntimeError> {
        let mut outcomes = Vec::with_capacity(classified.len());
        for (control, gesture) in classified {
            let mapping = self
                .controls
                .get(&control)
                .ok_or(RuntimeError::UnknownControl)?;
            let Some(entry) = mapping.entry(gesture) else {
                continue;
            };
            let target = match entry.target() {
                ScopeTarget::SelectedScope => self.state.control_state(&control)?.selected_scope(),
                ScopeTarget::Explicit(scope) => scope,
            }
            .clone();
            if entry.action() == Action::SelectScope {
                self.state.select_control_scope(&control, target.clone())?;
                tracing::info!(
                    source = "control",
                    action = "select_scope",
                    scope = ?target,
                    device = control.as_str(),
                    "selected runtime control scope"
                );
                outcomes.push(ActionSummary {
                    affected_owner_count: 0,
                    acknowledged_owner_count: 0,
                    recomputed_devices: 0,
                    durable_state_changed: true,
                });
                continue;
            }
            outcomes.push(self.apply_action(entry.action(), &target, now)?);
        }
        Ok(outcomes)
    }

    fn apply_action(
        &mut self,
        action: Action,
        target: &Scope,
        now: RuntimeInstant,
    ) -> Result<ActionSummary, RuntimeError> {
        if action == Action::SelectScope {
            return Err(RuntimeError::InvalidTopology(
                "scope selection requires a concrete control",
            ));
        }
        let affected = self.affected_owners(target);
        if affected.is_empty() {
            return Err(RuntimeError::InvalidTopology(
                "action target contains no physical owner",
            ));
        }

        let mut next_state = self.state.clone();
        let mut next_overlays = self.overlays.clone();
        let mut acknowledged = 0;
        match action {
            Action::AdjustBrightnessOffset(delta) => {
                for owner in &affected {
                    next_state.adjust_scope_offsets(owner, delta.get(), 0.0)?;
                }
            }
            Action::AdjustColorTemperatureOffset(delta) => {
                for owner in &affected {
                    next_state.adjust_scope_offsets(owner, 0.0, delta.get())?;
                }
            }
            Action::TogglePower => {
                let any_on = affected
                    .iter()
                    .any(|owner| next_state.scope_state(owner).is_ok_and(ScopeState::is_on));
                for owner in &affected {
                    next_state.set_scope_power(owner, !any_on)?;
                }
            }
            Action::ToggleCircadian => {
                let all_frozen = affected.iter().all(|owner| {
                    next_state
                        .scope_state(owner)
                        .is_ok_and(ScopeState::is_frozen)
                });
                for owner in &affected {
                    let curve = self.curves.get(owner).expect("owner curve exists");
                    let live = curve.sample(now.local_time);
                    let before = next_state.compose_scope_layers(owner, live, now.monotonic)?;
                    let outcome = if all_frozen {
                        next_state.unfreeze_scope_curve(
                            owner,
                            now.monotonic,
                            self.circadian.convergence_duration,
                        )?;
                        CurveToggleOutcome::Unfrozen
                    } else {
                        next_state.freeze_scope_curve(owner, live, now.monotonic)?;
                        CurveToggleOutcome::Frozen
                    };
                    if let Some(request) = self.acknowledgement.for_scope_toggle(outcome, &before) {
                        next_overlays
                            .get_mut(owner)
                            .expect("owner overlay exists")
                            .insert_request(request.into_overlay(), now.monotonic)?;
                        acknowledged += 1;
                    }
                }
            }
            Action::SelectScope => unreachable!("handled before owner fanout"),
        }

        self.state = next_state;
        self.overlays = next_overlays;
        tracing::info!(
            source = "control",
            action = ?action,
            scope = ?target,
            curve_mode = if matches!(action, Action::ToggleCircadian) { "changed" } else { "unchanged" },
            overlay = if acknowledged > 0 { "circadian_ack" } else { "none" },
            affected_owner_count = affected.len(),
            "applied declarative control action"
        );
        let (actions, recomputed_devices) = self.recompute_desired(now)?;
        self.queue_reconcile_actions(actions, now)?;
        Ok(ActionSummary {
            affected_owner_count: affected.len(),
            acknowledged_owner_count: acknowledged,
            recomputed_devices,
            durable_state_changed: true,
        })
    }

    pub fn reset_if_due(&mut self, now: RuntimeInstant) -> Result<bool, RuntimeError> {
        let mut next = self.state.clone();
        let outcome = next.reset_circadian_if_due(
            now.local_date,
            now.local_time,
            self.circadian.daily_reset_time,
            now.monotonic,
            self.circadian.convergence_duration,
        )?;
        if outcome.durable_state_changed() {
            self.state = next;
            let (actions, _) = self.recompute_desired(now)?;
            self.queue_reconcile_actions(actions, now)?;
            return Ok(true);
        }
        Ok(false)
    }

    fn affected_owners(&self, target: &Scope) -> Vec<Scope> {
        self.owners
            .iter()
            .filter(|owner| {
                self.devices
                    .values()
                    .any(|device| &device.owner == *owner && device.membership.is_in(target))
            })
            .cloned()
            .collect()
    }

    pub fn recompute_desired(
        &mut self,
        now: RuntimeInstant,
    ) -> Result<(Vec<ReconcileAction>, usize), RuntimeError> {
        self.recompute_desired_with_policy(now, true)
    }

    pub fn recompute_sparse(
        &mut self,
        now: RuntimeInstant,
    ) -> Result<(Vec<ReconcileAction>, usize), RuntimeError> {
        self.recompute_desired_with_policy(now, false)
    }

    fn recompute_desired_with_policy(
        &mut self,
        now: RuntimeInstant,
        force: bool,
    ) -> Result<(Vec<ReconcileAction>, usize), RuntimeError> {
        let mut underlying = BTreeMap::new();
        for owner in &self.owners {
            let live = self
                .curves
                .get(owner)
                .expect("owner has configured curve")
                .sample(now.local_time);
            underlying.insert(
                owner.clone(),
                self.state
                    .compose_scope_layers(owner, live, now.monotonic)?,
            );
        }

        let logical_color_temperature_range =
            KelvinRange::new(1_000.0, 40_000.0).expect("canonical Kelvin range is valid");
        let mut logical_targets = BTreeMap::new();
        for owner in &self.owners {
            logical_targets.insert(
                owner.clone(),
                self.overlays
                    .get_mut(owner)
                    .expect("owner overlay exists")
                    .compose(
                        *underlying.get(owner).expect("owner target exists"),
                        now.monotonic,
                        logical_color_temperature_range,
                    )?,
            );
        }

        let mut targets = BTreeMap::new();
        for (id, device) in &self.devices {
            let range = device.capabilities.color_temperature.unwrap_or_else(|| {
                KelvinRange::new(1_000.0, 40_000.0).expect("fallback Kelvin range is valid")
            });
            let target = self
                .overlays
                .get_mut(&device.owner)
                .expect("owner overlay exists")
                .compose(
                    *underlying.get(&device.owner).expect("owner target exists"),
                    now.monotonic,
                    range,
                )?;
            if self.last_targets.get(id) != Some(&target) {
                tracing::info!(
                    device = id.as_str(),
                    room = ?device.owner,
                    source = "composition",
                    old_target = ?self.last_targets.get(id),
                    new_target = ?target,
                    "computed device target"
                );
            }
            targets.insert(id.clone(), target);
        }

        let materially_changed: BTreeSet<_> = targets
            .iter()
            .filter(|(id, target)| {
                force
                    || self.last_targets.get(*id).is_none_or(|previous| {
                        target_change_exceeds_threshold(
                            previous,
                            target,
                            self.circadian.brightness_change_threshold,
                            self.circadian.color_temperature_change_threshold_kelvin,
                        )
                    })
            })
            .map(|(id, _)| id.clone())
            .collect();
        let refresh_due: BTreeSet<_> = self
            .devices
            .keys()
            .filter(|id| {
                !force
                    && self.last_reconciled_at.get(*id).is_some_and(|previous| {
                        now.monotonic.as_seconds() - previous.as_seconds()
                            >= self.circadian.maximum_refresh_seconds
                    })
            })
            .cloned()
            .collect();
        let update_devices: BTreeSet<_> = materially_changed
            .iter()
            .chain(&refresh_due)
            .cloned()
            .collect();

        if materially_changed.is_empty() && !refresh_due.is_empty() {
            let actions = self.reconciler.force_reconcile(now.monotonic)?;
            for id in refresh_due {
                self.last_reconciled_at.insert(id, now.monotonic);
            }
            return Ok((actions, self.devices.len()));
        }

        let mut actions = Vec::new();
        let mut grouped_members = BTreeSet::new();
        for group in &self.groups {
            let Some(shared_owner) = &group.shared_owner else {
                actions.extend(
                    self.reconciler
                        .clear_group_desired(&group.id, now.monotonic)?,
                );
                continue;
            };
            let member_targets: Vec<_> = group
                .members
                .iter()
                .filter_map(|member| targets.get(member).copied())
                .collect();
            let Some(first) = member_targets.first().copied() else {
                continue;
            };
            let common_fields_equal = member_targets.iter().all(|target| {
                target.on == first.on
                    && target.brightness == first.brightness
                    && target.color == first.color
                    && target.transition_ms == first.transition_ms
                    && (!group.has_group_color_temperature
                        || target.color_temperature == first.color_temperature)
            });
            if common_fields_equal
                && group.members.iter().all(|member| {
                    self.devices
                        .get(member)
                        .is_some_and(|device| &device.owner == shared_owner)
                })
            {
                // Preserve the owner-level target until Reconciler degrades it
                // independently for the group and each heterogeneous member.
                let logical = *logical_targets
                    .get(shared_owner)
                    .expect("shared owner has a logical target");
                if group
                    .members
                    .iter()
                    .any(|member| update_devices.contains(member))
                {
                    actions.extend(self.reconciler.set_group_desired(
                        &group.id,
                        logical,
                        now.monotonic,
                    )?);
                }
                grouped_members.extend(group.members.iter().cloned());
            } else {
                actions.extend(
                    self.reconciler
                        .clear_group_desired(&group.id, now.monotonic)?,
                );
            }
        }
        for (id, target) in &targets {
            if !grouped_members.contains(id) && update_devices.contains(id) {
                actions.extend(
                    self.reconciler
                        .set_device_desired(id, *target, now.monotonic)?,
                );
            }
        }
        for id in update_devices {
            if let Some(target) = targets.get(&id) {
                self.last_targets.insert(id.clone(), *target);
                self.last_reconciled_at.insert(id, now.monotonic);
            }
        }
        Ok((actions, self.devices.len()))
    }

    fn queue_reconcile_actions(
        &mut self,
        actions: Vec<ReconcileAction>,
        _now: RuntimeInstant,
    ) -> Result<(), RuntimeError> {
        self.pending_actions.extend(actions);
        Ok(())
    }

    pub fn take_reconcile_actions(&mut self) -> Vec<ReconcileAction> {
        std::mem::take(&mut self.pending_actions)
    }

    pub fn mqtt_settings(&self) -> &MqttSettings {
        &self.mqtt
    }

    pub fn adapter(&self) -> &Zigbee2MqttAdapter {
        &self.adapter
    }

    pub fn next_transient_deadline(&self) -> Option<MonotonicTime> {
        self.classifier
            .next_deadline()
            .into_iter()
            .chain(self.overlays.values().filter_map(OverlaySet::next_expiry))
            .chain(self.reconciler.next_deadline())
            .min_by(|left, right| left.as_seconds().total_cmp(&right.as_seconds()))
    }

    pub fn reconciler_mut(&mut self) -> &mut Reconciler {
        &mut self.reconciler
    }

    pub fn whole_hour(&self) -> WholeHourSettings {
        self.whole_hour
    }

    pub fn reconciliation_timing(&self) -> ReconciliationTiming {
        self.reconciliation_timing
    }
}

#[async_trait]
pub trait DurableStateWriter: Send {
    async fn save(&mut self, state: AutomationState) -> Result<(), RuntimeError>;

    fn is_healthy(&self) -> bool {
        true
    }
}

enum PersistenceRequest {
    Save(
        AutomationState,
        tokio::sync::oneshot::Sender<Result<(), PersistenceError>>,
    ),
}

pub struct SqliteWriter {
    sender: Option<std::sync::mpsc::SyncSender<PersistenceRequest>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl SqliteWriter {
    pub async fn open(path: impl AsRef<Path>) -> Result<(Self, AutomationState), RuntimeError> {
        let path = PathBuf::from(path.as_ref());
        tokio::task::spawn_blocking(move || {
            let store = SqliteStateStore::open(path)?;
            let state = store.load()?;
            let (sender, receiver) = std::sync::mpsc::sync_channel(16);
            let worker = std::thread::Builder::new()
                .name("house-automation-sqlite".to_owned())
                .spawn(move || persistence_loop(store, receiver))
                .map_err(|_| RuntimeError::PersistenceWorkerStopped)?;
            Ok::<_, RuntimeError>((
                Self {
                    sender: Some(sender),
                    worker: Some(worker),
                },
                state,
            ))
        })
        .await
        .map_err(|_| RuntimeError::PersistenceWorkerStopped)?
    }
}

impl Drop for SqliteWriter {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn persistence_loop(
    store: SqliteStateStore,
    receiver: std::sync::mpsc::Receiver<PersistenceRequest>,
) {
    while let Ok(request) = receiver.recv() {
        match request {
            PersistenceRequest::Save(state, completion) => {
                let _ = completion.send(store.save(&state));
            }
        }
    }
}

#[async_trait]
impl DurableStateWriter for SqliteWriter {
    async fn save(&mut self, state: AutomationState) -> Result<(), RuntimeError> {
        if self
            .worker
            .as_ref()
            .is_none_or(std::thread::JoinHandle::is_finished)
        {
            return Err(RuntimeError::PersistenceWorkerStopped);
        }
        let (completion, result) = tokio::sync::oneshot::channel();
        let sender = self
            .sender
            .as_ref()
            .ok_or(RuntimeError::PersistenceWorkerStopped)?
            .clone();
        tokio::task::spawn_blocking(move || {
            sender.send(PersistenceRequest::Save(state, completion))
        })
        .await
        .map_err(|_| RuntimeError::PersistenceWorkerStopped)?
        .map_err(|_| RuntimeError::PersistenceWorkerStopped)?;
        result
            .await
            .map_err(|_| RuntimeError::PersistenceWorkerStopped)??;
        Ok(())
    }

    fn is_healthy(&self) -> bool {
        self.worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
    }
}

#[derive(Debug, Clone)]
struct DelayedOperation {
    due_seconds: f64,
    sequence: u64,
    operation: AdapterOperation,
}

pub struct RuntimeActor<T, C, W> {
    engine: HouseEngine,
    transport: T,
    clock: C,
    writer: W,
    health: Arc<HealthState>,
    scheduler: Scheduler,
    delayed: Vec<DelayedOperation>,
    next_sequence: u64,
    stopping: bool,
}

impl<T, C, W> RuntimeActor<T, C, W>
where
    T: MqttTransport,
    C: Clock,
    W: DurableStateWriter,
{
    pub fn new(
        mut engine: HouseEngine,
        transport: T,
        clock: C,
        writer: W,
        health: Arc<HealthState>,
    ) -> Result<Self, RuntimeError> {
        let sample = clock.sample();
        let (_, _) = engine.recompute_desired(sample.runtime)?;
        // Desired state is now resident in the disconnected reconciler.
        // ConnAck will generate one fresh full plan; pre-connect actions must
        // not survive and duplicate that plan on the first timer tick.
        engine.take_reconcile_actions();
        let scheduler = Scheduler::new(engine.circadian.tick_seconds)
            .map_err(|_| RuntimeError::InvalidTopology("invalid scheduler interval"))?;
        Ok(Self {
            engine,
            transport,
            clock,
            writer,
            health,
            scheduler,
            delayed: Vec::new(),
            next_sequence: 0,
            stopping: false,
        })
    }

    pub fn engine(&self) -> &HouseEngine {
        &self.engine
    }

    pub async fn handle_transport_event(
        &mut self,
        event: TransportEvent,
    ) -> Result<(), RuntimeError> {
        if self.stopping {
            return Ok(());
        }
        self.ensure_writer_healthy()?;
        let sample = self.clock.sample();
        self.persist_reset_if_due(sample.runtime).await?;
        match event {
            TransportEvent::Connected => {
                tracing::info!(source = "mqtt", mqtt_reconnect = true, "broker connected");
                self.health.set_mqtt_connected(false);
                let actions = self
                    .engine
                    .reconciler
                    .broker_connected(sample.runtime.monotonic)?;
                self.enqueue_actions(actions, sample.runtime).await?;
                self.transport
                    .publish(
                        &status_topic(&self.engine.mqtt.application_namespace),
                        b"online",
                        crate::zigbee2mqtt::Qos::AtLeastOnce,
                        true,
                    )
                    .await?;
                self.health.set_mqtt_connected(true);
            }
            TransportEvent::Disconnected => {
                tracing::warn!(
                    source = "mqtt",
                    mqtt_reconnect = false,
                    "broker disconnected"
                );
                self.health.set_mqtt_connected(false);
                self.health.set_bridge_online(false);
                self.delayed.clear();
                self.engine
                    .reconciler
                    .broker_disconnected(sample.runtime.monotonic)?;
            }
            TransportEvent::Publish(message) => {
                let bridge_state_topic =
                    format!("{}/bridge/state", self.engine.mqtt.zigbee2mqtt_base_topic);
                let is_bridge_state = message.topic == bridge_state_topic;
                let parsed = match self.engine.adapter.parse(&message.as_inbound()) {
                    Ok(parsed) => parsed,
                    Err(error) if !error.is_permanent() => {
                        if is_bridge_state {
                            self.health.set_bridge_online(false);
                        }
                        tracing::warn!(
                            source = "zigbee2mqtt",
                            message_kind = if is_bridge_state {
                                "bridge_state"
                            } else {
                                "adapter_event"
                            },
                            retained = message.retain,
                            "discarded malformed external MQTT message"
                        );
                        return Ok(());
                    }
                    Err(error) => return Err(error.into()),
                };
                let Some(inbound) = parsed else {
                    return Ok(());
                };
                self.handle_inbound(inbound, sample).await?;
            }
        }
        Ok(())
    }

    async fn persist_reset_if_due(&mut self, now: RuntimeInstant) -> Result<(), RuntimeError> {
        let mut next = self.engine.clone();
        if !next.reset_if_due(now)? {
            return Ok(());
        }
        self.writer.save(next.state.clone()).await?;
        self.engine = next;
        self.drain_engine_actions(now).await
    }

    fn ensure_writer_healthy(&self) -> Result<(), RuntimeError> {
        if self.writer.is_healthy() {
            return Ok(());
        }
        self.health.set_database_migrated(false);
        Err(RuntimeError::PersistenceWorkerStopped)
    }

    async fn handle_inbound(
        &mut self,
        inbound: InboundEvent,
        sample: crate::scheduler::ClockSample,
    ) -> Result<(), RuntimeError> {
        let actions = match inbound {
            InboundEvent::BridgeAvailability(availability) => {
                tracing::info!(source = "zigbee2mqtt", availability = ?availability, "bridge availability changed");
                self.health
                    .set_bridge_online(availability == Availability::Online);
                self.engine
                    .reconciler
                    .set_bridge_availability(availability, sample.runtime.monotonic)?
            }
            InboundEvent::DeviceAvailability {
                device,
                availability,
            } => {
                tracing::info!(device = device.as_str(), source = "zigbee2mqtt", availability = ?availability, "device availability changed");
                self.engine.reconciler.set_device_availability(
                    &device,
                    availability,
                    sample.runtime.monotonic,
                )?
            }
            InboundEvent::DeviceState { device, state } => {
                self.engine
                    .reconciler
                    .observe(&device, state, sample.runtime.monotonic)?
            }
            InboundEvent::Input { control, event } => {
                tracing::info!(source = "zigbee2mqtt", device = control.as_str(), action = ?event, "received normalized control input");
                let mut next = self.engine.clone();
                let outcomes = next.handle_input(control, event, sample.runtime)?;
                if outcomes.iter().any(|outcome| outcome.durable_state_changed) {
                    self.writer.save(next.state.clone()).await?;
                }
                self.engine = next;
                self.drain_engine_actions(sample.runtime).await?;
                return Ok(());
            }
            InboundEvent::UnknownInputAction { .. } => Vec::new(),
        };
        self.enqueue_actions(actions, sample.runtime).await
    }

    pub async fn tick(&mut self) -> Result<(), RuntimeError> {
        if self.stopping {
            return Ok(());
        }
        self.ensure_writer_healthy()?;
        let mut sample = self.clock.sample();
        let due = self.scheduler.observe(&sample);

        let mut next = self.engine.clone();
        let input_outcomes = next.flush_input(sample.runtime)?;
        let reset_changed = next.reset_if_due(sample.runtime)?;
        if input_outcomes
            .iter()
            .any(|outcome| outcome.durable_state_changed)
            || reset_changed
        {
            self.writer.save(next.state.clone()).await?;
            self.engine = next;
        } else if !input_outcomes.is_empty() {
            self.engine = next;
        }
        self.drain_engine_actions(sample.runtime).await?;
        sample = self.clock.sample();

        if due.whole_hour {
            self.engine.start_whole_hour_overlay(sample.runtime)?;
            self.drain_engine_actions(sample.runtime).await?;
        } else if self
            .engine
            .next_transient_deadline()
            .is_some_and(|deadline| sample.runtime.monotonic >= deadline)
        {
            let (actions, _) = self.engine.recompute_desired(sample.runtime)?;
            self.enqueue_actions(actions, sample.runtime).await?;
        } else if due.curve_tick {
            let (actions, _) = self.engine.recompute_sparse(sample.runtime)?;
            self.enqueue_actions(actions, sample.runtime).await?;
        }

        sample = self.clock.sample();
        let retry = self.engine.reconciler.retry_due(sample.runtime.monotonic)?;
        self.enqueue_actions(retry, sample.runtime).await?;
        self.execute_due(self.clock.sample().runtime).await
    }

    async fn drain_engine_actions(&mut self, now: RuntimeInstant) -> Result<(), RuntimeError> {
        let actions = self.engine.take_reconcile_actions();
        self.enqueue_actions(actions, now).await
    }

    async fn enqueue_actions(
        &mut self,
        actions: Vec<ReconcileAction>,
        now: RuntimeInstant,
    ) -> Result<(), RuntimeError> {
        if actions.is_empty() {
            return Ok(());
        }
        let dispatch_tokens: BTreeSet<_> = actions
            .iter()
            .filter_map(|action| match action {
                ReconcileAction::Command { token, .. } => Some(*token),
                ReconcileAction::Resubscribe | ReconcileAction::RequestState(_) => None,
            })
            .collect();
        let plan = match self
            .engine
            .adapter
            .apply_actions(PlanEpoch::new(now.monotonic), &actions)
        {
            Ok(plan) => plan,
            Err(error) => {
                if error.is_permanent() {
                    let failed_at = self.clock.sample().runtime.monotonic;
                    for token in dispatch_tokens {
                        self.engine.reconciler.cancel_dispatch(token, failed_at)?;
                    }
                }
                return Err(error.into());
            }
        };
        for metadata in plan.dispatch_plans() {
            self.engine.reconciler.register_dispatch_plan(
                metadata.token(),
                plan.epoch().monotonic_time(),
                metadata.operation_count(),
                metadata.max_offset_ms(),
            )?;
        }
        for operation in plan.operations().iter().cloned() {
            let delay_ms = operation
                .publication()
                .map(|publication| publication.not_before_ms())
                .unwrap_or_default();
            if delay_ms == 0 {
                self.execute_operation(operation).await?;
            } else {
                let due_seconds = now.monotonic.as_seconds() + delay_ms as f64 / 1000.0;
                if !due_seconds.is_finite() {
                    return Err(RuntimeError::InvalidTopology(
                        "adapter operation deadline overflow",
                    ));
                }
                self.delayed.push(DelayedOperation {
                    due_seconds,
                    sequence: self.next_sequence,
                    operation,
                });
                self.next_sequence =
                    self.next_sequence
                        .checked_add(1)
                        .ok_or(RuntimeError::InvalidTopology(
                            "adapter operation sequence exhausted",
                        ))?;
            }
        }
        Ok(())
    }

    async fn execute_due(&mut self, now: RuntimeInstant) -> Result<(), RuntimeError> {
        self.delayed.sort_by(|left, right| {
            left.due_seconds
                .total_cmp(&right.due_seconds)
                .then_with(|| left.sequence.cmp(&right.sequence))
        });
        let due_count = self
            .delayed
            .partition_point(|operation| operation.due_seconds <= now.monotonic.as_seconds());
        let due: Vec<_> = self.delayed.drain(..due_count).collect();
        for operation in due {
            self.execute_operation(operation.operation).await?;
        }
        Ok(())
    }

    async fn execute_operation(&mut self, operation: AdapterOperation) -> Result<(), RuntimeError> {
        match operation {
            AdapterOperation::Subscribe(subscription) => self
                .transport
                .subscribe(subscription.topic(), subscription.qos())
                .await
                .map_err(RuntimeError::from),
            AdapterOperation::Publish(publication) => {
                let Some(token) = publication.dispatch_token() else {
                    return self
                        .transport
                        .publish(
                            publication.topic(),
                            publication.payload(),
                            publication.qos(),
                            publication.retain(),
                        )
                        .await
                        .map_err(RuntimeError::from);
                };
                let index =
                    publication
                        .dispatch_operation_index()
                        .ok_or(RuntimeError::InvalidTopology(
                            "command publication lacks operation index",
                        ))?;
                let claim = self.engine.reconciler.claim_next_operation(token, index)?;
                let DispatchClaim::Ready(permit) = claim else {
                    return Ok(());
                };
                let enqueue = tokio::time::timeout(
                    Duration::from_secs_f64(
                        self.engine
                            .reconciliation_timing
                            .dispatch_acceptance_margin_seconds,
                    ),
                    self.transport.publish(
                        publication.topic(),
                        publication.payload(),
                        publication.qos(),
                        publication.retain(),
                    ),
                )
                .await;
                let outcome_sample = self.clock.sample();
                match enqueue {
                    Ok(Ok(())) => {
                        let acceptance = permit.accepted(outcome_sample.runtime.monotonic)?;
                        if acceptance == DispatchAcceptance::BatchAccepted {
                            self.health
                                .record_reconciliation(outcome_sample.unix_seconds);
                        }
                        Ok(())
                    }
                    Ok(Err(_)) | Err(_) => {
                        permit.transient_failure(outcome_sample.runtime.monotonic)?;
                        Ok(())
                    }
                }
            }
        }
    }

    fn next_delay(&self) -> Duration {
        let sample = self.clock.sample();
        let now = sample.runtime.monotonic.as_seconds();
        let transient = self
            .engine
            .next_transient_deadline()
            .map(|deadline| (deadline.as_seconds() - now + 0.001).max(0.001));
        let delayed = self
            .delayed
            .iter()
            .map(|operation| operation.due_seconds)
            .min_by(f64::total_cmp)
            .map(|deadline| (deadline - now).max(0.001));
        let scheduler = self
            .scheduler
            .next_tick_delay(sample.runtime.monotonic)
            .as_secs_f64();
        let wall = self
            .scheduler
            .next_wall_event_delay(&sample, self.engine.circadian.daily_reset_time)
            .as_secs_f64();
        Duration::from_secs_f64(
            transient
                .into_iter()
                .chain(delayed)
                .chain([scheduler, wall])
                .min_by(f64::total_cmp)
                .unwrap_or(1.0),
        )
    }

    pub async fn run_until(
        &mut self,
        shutdown: impl Future<Output = ()> + Send,
    ) -> Result<(), RuntimeError> {
        tokio::pin!(shutdown);
        loop {
            let delay = self.next_delay();
            tokio::select! {
                event = self.transport.next_event() => {
                    match event {
                        Ok(event) => self.handle_transport_event(event).await?,
                        Err(error) => {
                            self.handle_transport_event(TransportEvent::Disconnected).await?;
                            if !error.is_transient() {
                                return Err(error.into());
                            }
                        }
                    }
                }
                () = tokio::time::sleep(delay) => self.tick().await?,
                () = &mut shutdown => return self.shutdown().await,
            }
        }
    }

    pub async fn shutdown(&mut self) -> Result<(), RuntimeError> {
        if self.stopping {
            return Ok(());
        }
        self.stopping = true;
        self.health.set_mqtt_connected(false);
        self.health.set_bridge_online(false);
        let save = self.writer.save(self.engine.state.clone()).await;
        let transport = self
            .transport
            .shutdown(&status_topic(&self.engine.mqtt.application_namespace))
            .await
            .map_err(RuntimeError::from);
        save.and(transport)
    }
}

const MAX_RUNTIME_CONFIG_BYTES: u64 = 1024 * 1024;

pub async fn run_service(config_path: &Path, state_path: &Path) -> Result<(), RuntimeError> {
    let config_metadata = tokio::fs::metadata(config_path)
        .await
        .map_err(|_| RuntimeError::Io("cannot inspect runtime configuration"))?;
    if !config_metadata.is_file() || config_metadata.len() > MAX_RUNTIME_CONFIG_BYTES {
        return Err(RuntimeError::Io(
            "runtime configuration must be a bounded regular file",
        ));
    }
    let config_bytes = tokio::fs::read(config_path)
        .await
        .map_err(|_| RuntimeError::Io("cannot read runtime configuration"))?;
    let config_text = std::str::from_utf8(&config_bytes)
        .map_err(|_| RuntimeError::Io("runtime configuration must be UTF-8"))?;
    let parts = ValidatedConfig::parse(config_text)?.into_runtime_parts();
    let health_bind = parts.health.bind;

    // Migration, load, config-authoritative normalization, missed daily reset,
    // and durable save all finish before any MQTT client is constructed.
    let (mut writer, persisted) = SqliteWriter::open(state_path).await?;
    let clock = TokioClock::stockholm_now();
    let engine = HouseEngine::initialize(parts, persisted, clock.sample().runtime)?;
    writer.save(engine.state.clone()).await?;

    let credentials = engine
        .mqtt
        .credentials
        .as_ref()
        .map(load_credentials)
        .transpose()?;
    let transport = RumqttTransport::connect(&engine.mqtt, credentials.as_ref())?;
    let health = Arc::new(HealthState::new());
    health.set_database_migrated(true);
    let listener = crate::health::bind(health_bind)
        .await
        .map_err(|_| RuntimeError::Io("cannot bind health listener"))?;
    let (health_shutdown, health_shutdown_rx) = tokio::sync::oneshot::channel();
    let mut health_task = tokio::spawn(crate::health::serve(listener, health.clone(), async {
        let _ = health_shutdown_rx.await;
    }));
    let mut actor = RuntimeActor::new(engine, transport, clock, writer, health)?;

    let actor_result = tokio::select! {
        result = actor.run_until(shutdown_signal()) => {
            if result.is_err() {
                let _ = actor.shutdown().await;
            }
            let _ = health_shutdown.send(());
            match health_task.await {
                Ok(Ok(())) => result,
                Ok(Err(_)) | Err(_) if result.is_ok() => Err(RuntimeError::HealthServerStopped),
                Ok(Err(_)) | Err(_) => result,
            }
        },
        result = &mut health_task => {
            let _ = actor.shutdown().await;
            match result {
                Ok(Ok(())) => Err(RuntimeError::HealthServerStopped),
                Ok(Err(_)) | Err(_) => Err(RuntimeError::HealthServerStopped),
            }
        }
    };
    actor_result
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler installation failed");
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                let _ = result;
            }
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn normalize_state(
    persisted: AutomationState,
    configured_scopes: &BTreeSet<Scope>,
    controls: &[crate::config::ControlConfiguration],
) -> Result<AutomationState, RuntimeError> {
    let snapshot = persisted.snapshot().into_parts();
    let persisted_scopes: BTreeMap<_, _> = snapshot
        .scopes
        .into_iter()
        .map(|scope| (scope.scope().clone(), scope))
        .collect();
    let configured_controls: BTreeMap<_, _> = controls
        .iter()
        .map(|control| {
            let mut allowed_scopes = BTreeSet::from([control.selected_scope.clone()]);
            for gesture in all_gestures() {
                if let Some(entry) = control.mapping.entry(gesture)
                    && entry.action() == Action::SelectScope
                    && let ScopeTarget::Explicit(scope) = entry.target()
                {
                    allowed_scopes.insert(scope.clone());
                }
            }
            (
                control.id.clone(),
                (
                    control.selected_scope.clone(),
                    control.aliases.clone(),
                    allowed_scopes,
                ),
            )
        })
        .collect();
    let persisted_controls: BTreeMap<_, _> = snapshot
        .controls
        .into_iter()
        .map(|control| (control.id().clone(), control.selected_scope().clone()))
        .collect();

    let mut normalized = snapshot
        .last_reset_date
        .map(AutomationState::with_last_reset_date)
        .unwrap_or_default();
    for scope in configured_scopes {
        let state = persisted_scopes
            .get(scope)
            .map(|persisted| {
                let one = house_automation_core::state::AutomationSnapshot::from_parts(
                    house_automation_core::state::AutomationSnapshotParts {
                        scopes: vec![persisted.clone()],
                        controls: Vec::new(),
                        last_reset_date: None,
                    },
                );
                AutomationState::restore(one).and_then(|state| state.scope_state(scope).cloned())
            })
            .transpose()?
            // Newly configured lights start safe/off; explicit user action turns them on.
            .unwrap_or_else(|| ScopeState::new(false));
        normalized.insert_scope(scope.clone(), state)?;
    }
    for (id, (default_scope, aliases, allowed_scopes)) in configured_controls {
        let selected = persisted_controls
            .get(&id)
            .or_else(|| {
                aliases
                    .iter()
                    .find_map(|alias| persisted_controls.get(alias))
            })
            .filter(|scope| allowed_scopes.contains(*scope))
            .cloned()
            .unwrap_or(default_scope);
        normalized.insert_control(id, ControlState::new(selected))?;
    }
    Ok(normalized)
}

fn all_gestures() -> impl Iterator<Item = Gesture> {
    [
        Gesture::Up,
        Gesture::Down,
        Gesture::Left,
        Gesture::Right,
        Gesture::CenterSingle,
        Gesture::CenterDouble,
        Gesture::CenterLong,
        Gesture::CenterRelease,
        Gesture::DirectionHold(Direction::Up),
        Gesture::DirectionHold(Direction::Down),
        Gesture::DirectionHold(Direction::Left),
        Gesture::DirectionHold(Direction::Right),
        Gesture::DirectionRelease(Direction::Up),
        Gesture::DirectionRelease(Direction::Down),
        Gesture::DirectionRelease(Direction::Left),
        Gesture::DirectionRelease(Direction::Right),
    ]
    .into_iter()
}

fn resolve_owner(
    scopes: &BTreeSet<Scope>,
    membership: &ScopeMembership,
) -> Result<Scope, RuntimeError> {
    let mut matching: Vec<_> = scopes
        .iter()
        .filter(|scope| membership.is_in(scope))
        .cloned()
        .collect();
    matching.sort_by_key(scope_rank);
    matching.pop().ok_or(RuntimeError::InvalidTopology(
        "controllable device has no configured physical owner",
    ))
}

fn scope_rank(scope: &Scope) -> u8 {
    match scope {
        Scope::Room(_) => 3,
        Scope::Floor(_) => 2,
        Scope::House => 1,
    }
}

fn target_change_exceeds_threshold(
    previous: &LightTarget,
    next: &LightTarget,
    brightness_threshold: f64,
    color_temperature_threshold_kelvin: f64,
) -> bool {
    previous.on != next.on
        || previous.color != next.color
        || previous.transition_ms != next.transition_ms
        || match (previous.brightness, next.brightness) {
            (Some(previous), Some(next)) => {
                (previous.get() - next.get()).abs() >= brightness_threshold
            }
            (None, None) => false,
            _ => true,
        }
        || match (previous.color_temperature, next.color_temperature) {
            (Some(previous), Some(next)) => {
                (previous.get() - next.get()).abs() >= color_temperature_threshold_kelvin
            }
            (None, None) => false,
            _ => true,
        }
}

#[derive(Debug)]
pub enum RuntimeError {
    InvalidInstant,
    InvalidTopology(&'static str),
    UnknownDevice,
    UnknownControl,
    UnmappedGesture,
    State(house_automation_core::state::StateError),
    Input(house_automation_core::input::InputError),
    Overlay(house_automation_core::overlay::OverlayError),
    Reconcile(house_automation_core::reconcile::ReconcileError),
    Adapter(crate::zigbee2mqtt::AdapterError),
    Mqtt(crate::mqtt::MqttError),
    Persistence(PersistenceError),
    PersistenceWorkerStopped,
    Config(crate::config::ConfigError),
    Io(&'static str),
    HealthServerStopped,
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInstant => formatter.write_str("invalid runtime instant"),
            Self::InvalidTopology(reason) => {
                write!(formatter, "invalid runtime topology: {reason}")
            }
            Self::UnknownDevice => formatter.write_str("unknown runtime device"),
            Self::UnknownControl => formatter.write_str("unknown runtime control"),
            Self::UnmappedGesture => formatter.write_str("gesture is not mapped"),
            Self::State(error) => write!(formatter, "state transition failed: {error}"),
            Self::Input(error) => write!(formatter, "input classification failed: {error}"),
            Self::Overlay(error) => write!(formatter, "overlay composition failed: {error}"),
            Self::Reconcile(error) => write!(formatter, "reconciliation failed: {error}"),
            Self::Adapter(error) => write!(formatter, "adapter operation failed: {error}"),
            Self::Mqtt(error) => write!(formatter, "MQTT operation failed: {error}"),
            Self::Persistence(error) => {
                write!(formatter, "persistent state operation failed: {error}")
            }
            Self::PersistenceWorkerStopped => {
                formatter.write_str("persistent state worker stopped")
            }
            Self::Config(error) => write!(formatter, "configuration failed: {error}"),
            Self::Io(message) => formatter.write_str(message),
            Self::HealthServerStopped => formatter.write_str("health server stopped unexpectedly"),
        }
    }
}

impl Error for RuntimeError {}

impl From<house_automation_core::state::StateError> for RuntimeError {
    fn from(value: house_automation_core::state::StateError) -> Self {
        Self::State(value)
    }
}

impl From<house_automation_core::input::InputError> for RuntimeError {
    fn from(value: house_automation_core::input::InputError) -> Self {
        Self::Input(value)
    }
}

impl From<house_automation_core::overlay::OverlayError> for RuntimeError {
    fn from(value: house_automation_core::overlay::OverlayError) -> Self {
        Self::Overlay(value)
    }
}

impl From<house_automation_core::reconcile::ReconcileError> for RuntimeError {
    fn from(value: house_automation_core::reconcile::ReconcileError) -> Self {
        Self::Reconcile(value)
    }
}

impl From<crate::zigbee2mqtt::AdapterError> for RuntimeError {
    fn from(value: crate::zigbee2mqtt::AdapterError) -> Self {
        Self::Adapter(value)
    }
}

impl From<crate::mqtt::MqttError> for RuntimeError {
    fn from(value: crate::mqtt::MqttError) -> Self {
        Self::Mqtt(value)
    }
}

impl From<PersistenceError> for RuntimeError {
    fn from(value: PersistenceError) -> Self {
        Self::Persistence(value)
    }
}

impl From<crate::config::ConfigError> for RuntimeError {
    fn from(value: crate::config::ConfigError) -> Self {
        Self::Config(value)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use chrono::TimeZone;
    use chrono_tz::Europe::Stockholm;
    use house_automation_core::{
        reconcile::{CommandEntity, DeviceId, ReconcileAction},
        state::{AutomationState, LocalDate, MonotonicTime},
    };

    use crate::{
        config::ValidatedConfig,
        health::HealthState,
        mqtt::{MqttError, MqttTransport, TransportEvent},
        scheduler::{Clock, ClockSample},
        zigbee2mqtt::Qos,
    };

    use super::{DurableStateWriter, HouseEngine, RuntimeActor, RuntimeError, RuntimeInstant};

    struct NoopTransport;

    #[async_trait]
    impl MqttTransport for NoopTransport {
        async fn next_event(&mut self) -> Result<TransportEvent, MqttError> {
            std::future::pending().await
        }

        async fn subscribe(&mut self, _topic: &str, _qos: Qos) -> Result<(), MqttError> {
            Ok(())
        }

        async fn publish(
            &mut self,
            _topic: &str,
            _payload: &[u8],
            _qos: Qos,
            _retain: bool,
        ) -> Result<(), MqttError> {
            Ok(())
        }

        async fn shutdown(&mut self, _status_topic: &str) -> Result<(), MqttError> {
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FixedClock(ClockSample);

    impl Clock for FixedClock {
        fn sample(&self) -> ClockSample {
            self.0.clone()
        }
    }

    struct NoopWriter;

    #[async_trait]
    impl DurableStateWriter for NoopWriter {
        async fn save(&mut self, _state: AutomationState) -> Result<(), RuntimeError> {
            Ok(())
        }
    }

    fn sample(seconds: f64) -> ClockSample {
        let wall = Stockholm.with_ymd_and_hms(2026, 9, 13, 12, 0, 0).unwrap();
        ClockSample {
            wall,
            runtime: RuntimeInstant::new(
                LocalDate::new(2026, 9, 13).unwrap(),
                12,
                0,
                0,
                MonotonicTime::from_seconds(seconds).unwrap(),
            )
            .unwrap(),
            unix_seconds: wall.timestamp(),
        }
    }

    #[tokio::test]
    async fn permanent_adapter_plan_error_cancels_every_affected_dispatch_token() {
        let engine = HouseEngine::initialize(
            ValidatedConfig::parse(include_str!("../../examples/house.toml"))
                .unwrap()
                .into_runtime_parts(),
            Default::default(),
            sample(0.0).runtime,
        )
        .unwrap();
        let mut actor = RuntimeActor::new(
            engine,
            NoopTransport,
            FixedClock(sample(0.1)),
            NoopWriter,
            Arc::new(HealthState::new()),
        )
        .unwrap();
        let actions = actor
            .engine
            .reconciler
            .broker_connected(sample(0.1).runtime.monotonic)
            .unwrap();
        let mut token = None;
        let malformed: Vec<_> = actions
            .into_iter()
            .map(|action| match action {
                ReconcileAction::Command {
                    token: command_token,
                    target,
                    ..
                } => {
                    token.get_or_insert(command_token);
                    ReconcileAction::Command {
                        token: command_token,
                        entity: CommandEntity::Device(DeviceId::new("unbound-device").unwrap()),
                        target,
                    }
                }
                other => other,
            })
            .collect();
        let token = token.expect("reconnect produces a command token");

        let error = actor
            .enqueue_actions(malformed, sample(0.1).runtime)
            .await
            .unwrap_err();

        assert!(matches!(error, RuntimeError::Adapter(ref error) if error.is_permanent()));
        assert!(!actor.engine.reconciler.is_dispatch_token_valid(token));
    }

    #[tokio::test]
    async fn sqlite_writer_detects_an_unexpectedly_stopped_worker() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || drop(receiver));
        let mut writer = super::SqliteWriter {
            sender: Some(sender),
            worker: Some(worker),
        };

        let error = writer.save(AutomationState::default()).await.unwrap_err();

        assert!(matches!(error, RuntimeError::PersistenceWorkerStopped));
    }
}
