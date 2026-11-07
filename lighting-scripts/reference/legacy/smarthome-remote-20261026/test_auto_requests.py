import copy
import json
import unittest
from test_autogroup_planner import ROOT, HomeAssistant, Template, cv, Script, Context
from homeassistant.util.dt import utcnow

FIXTURE=json.loads((ROOT/'autogroup-fixtures.json').read_text())
GROUP='ls_auto_living_room_1'
MEMBER={'ieee_address':'0x0000000000000001','endpoint':1}

class RequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hass=HomeAssistant(str(ROOT/'requests-isolated-ha'))
        self.config=json.loads((ROOT/'auto-request.json').read_text())
        self.published=[]
        self.behavior='ok'
        self.hass.states.async_set('sensor.ls_effects_runtime','ready',{'generation':'unchanged','targets':{'untouched':True}})
        async def publish(call):
            self.published.append(dict(call.data))
            request=json.loads(call.data['payload'])
            attrs=dict(self.hass.states.get('sensor.ls_effects_runtime').attributes)
            if self.behavior!='timeout':
                attrs['auto_response']={'transaction':request['transaction'] if self.behavior!='wrong_token' else 'unrelated','status':'error' if self.behavior=='error' else 'ok'}
            groups=[{'friendly_name':GROUP,'id':42,'members':[] if self.operation=='remove' else [MEMBER]}]
            if self.behavior=='wrong_members':groups[0]['members']=[] if self.operation=='add' else [MEMBER]
            if self.behavior=='missing_group':groups=[]
            if self.behavior=='other_group':groups[0]['friendly_name']='ls_auto_other_1'
            attrs.update(auto_groups=groups,auto_groups_observed_at=0 if self.behavior=='stale' else utcnow().timestamp()+1)
            # Deliberately write BEFORE mqtt.publish returns: response must not be lost.
            self.hass.states.async_set('sensor.ls_effects_runtime','ready',attrs)
        self.hass.services.async_register('mqtt','publish',publish)

    async def asyncTearDown(self):await self.hass.async_stop()

    async def request(self,operation='add',**changes):
        self.operation=operation
        config=copy.deepcopy(self.config)
        def bounded(actions):
            for action in actions:
                # Test-only targeted substitution: production wait timeouts remain10s.
                if 'wait_template' in action:action['timeout']={'milliseconds':10}
                for key in ['then','else']:
                    if key in action:bounded(action[key])
        bounded(config['sequence'])
        script=Script(self.hass,cv.SCRIPT_SCHEMA(config['sequence']),'request','script',script_mode='queued')
        result=await script.async_run(dict(operation=operation,group=GROUP,member=MEMBER,**changes),Context())
        return result.service_response

    async def test_fast_ack_and_full_readback_succeed_for_all_operations(self):
        for operation in ['create','options','add','remove']:
            with self.subTest(operation=operation):
                result=await self.request(operation)
                self.assertTrue(result['ok'])
                sent=self.published[-1]
                self.assertEqual(sent['qos'],0)
                self.assertFalse(sent['retain'])
                payload=json.loads(sent['payload'])
                self.assertTrue(payload['transaction'].startswith('autogroup:'))
                self.assertEqual(result['request'],payload)
                if operation=='create':
                    self.assertEqual(payload['friendly_name'],GROUP)
                    self.assertNotIn('id',payload)
                elif operation=='options':
                    self.assertEqual(payload['id'],GROUP)
                    self.assertEqual(payload['options'],{'homeassistant':False})
                else:
                    self.assertEqual(payload['device'],MEMBER['ieee_address'])
                    self.assertEqual(payload['endpoint'],1)
                    self.assertTrue(payload['skip_disable_reporting'])

    async def test_ack_timeout_wrong_token_and_error_fail(self):
        for behavior in ['timeout','wrong_token','error']:
            with self.subTest(behavior=behavior):
                self.behavior=behavior
                self.assertFalse((await self.request())['ok'])

    async def test_incomplete_stale_wrong_or_missing_readback_fail(self):
        for operation in ['create','add','remove']:
            for behavior in ['stale','missing_group','other_group']+(['wrong_members'] if operation!='create' else []):
                with self.subTest(operation=operation,behavior=behavior):
                    self.behavior=behavior
                    self.assertFalse((await self.request(operation))['ok'])

    async def test_options_only_needs_ack(self):
        self.behavior='missing_group'
        self.assertTrue((await self.request('options'))['ok'])

    async def test_unmanaged_group_or_bad_member_never_publishes(self):
        before=len(self.published)
        # Inputs are malformed; helper must fail closed before publishing.
        config=copy.deepcopy(self.config)
        for variables in [dict(operation='add',group='kitchen/all',member=MEMBER),dict(operation='delete',group=GROUP,member=MEMBER),dict(operation='add',group=GROUP,member=dict(MEMBER,endpoint=True))]:
            script=Script(self.hass,cv.SCRIPT_SCHEMA(config['sequence']),'invalid','script')
            result=await script.async_run(variables,Context())
            self.assertFalse(result.service_response['ok'])
        self.assertEqual(len(self.published),before)

class StateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hass=HomeAssistant(str(ROOT/'state-isolated-ha'))
        self.config=json.loads((ROOT/'auto-state-automation.json').read_text())
        self.template=Template(self.config['actions'][0]['variables']['attributes'],self.hass)

    async def asyncTearDown(self):await self.hass.async_stop()

    def state(self,kind,payload):
        return self.template.async_render({'trigger':{'id':kind,'payload_json':payload}},parse_result=True)

    def test_actual_groups_complete_and_sorted(self):
        result=self.state('groups',FIXTURE['bridge_groups'])
        self.assertGreater(result['auto_groups_observed_at'],0)
        self.assertEqual(len(result['auto_groups']),len(FIXTURE['bridge_groups']))
        for g in result['auto_groups']:
            self.assertEqual(set(g),{'friendly_name','id','members'})
            original=next(x for x in FIXTURE['bridge_groups'] if x['id']==g['id'])
            self.assertEqual(g['members'],sorted(original['members'],key=lambda m:(m['ieee_address'],m['endpoint'])))

    def test_malformed_groups_invalidate_without_partial_snapshot(self):
        for mutate in [lambda g:g.append(copy.deepcopy(g[0])),lambda g:g[0]['members'].append(copy.deepcopy(g[0]['members'][0])),lambda g:g[0].update(id=True),lambda g:g[0]['members'][0].update(endpoint=0),lambda g:g[0].update(members=None),lambda g:g[0]['members'][0].update(ieee_address='bad')]:
            raw=copy.deepcopy(FIXTURE['bridge_groups']);mutate(raw)
            self.assertEqual(self.state('groups',raw),{'auto_groups_observed_at':0})
        self.assertEqual(self.state('groups',None),{'auto_groups_observed_at':0})

    def test_devices_only_full_lighting_input_clusters_and_ambiguity_preserved(self):
        def device(i,endpoints,type='Router'):
            return {'ieee_address':f'0x{i:016x}','type':type,'endpoints':{str(k):{'clusters':{'input':v,'output':['genOnOff','genLevelCtrl']}} for k,v in endpoints.items()}}
        raw=[device(1,{1:['genOnOff','genLevelCtrl']}),device(2,{1:['genOnOff','lightingColorCtrl'],2:['genOnOff','genLevelCtrl']}),device(3,{1:['genOnOff']}),device(4,{1:['msTemperatureMeasurement']}),device(5,{242:[]},'Coordinator')]
        result=self.state('devices',raw)
        self.assertGreater(result['auto_devices_observed_at'],0)
        self.assertEqual(result['auto_endpoints'],{'0x0000000000000001':[1],'0x0000000000000002':[1,2]})
        raw.append(copy.deepcopy(raw[0]))
        self.assertEqual(self.state('devices',raw),{'auto_devices_observed_at':0})

    def test_malformed_device_snapshot_never_partial(self):
        for raw in [None,{},[{'ieee_address':'bad','endpoints':{}}],[{'ieee_address':'0x0000000000000001','endpoints':{'1':{'clusters':{'input':'genOnOff'}}}}]]:
            self.assertEqual(self.state('devices',raw),{'auto_devices_observed_at':0})

    def test_only_own_response_tokens_recorded(self):
        self.assertEqual(self.state('response',{'transaction':'candle:1','status':'ok'}),{})
        self.assertEqual(self.state('response',None),{})
        result=self.state('response',{'transaction':'autogroup:1','status':'error','error':'full'})
        self.assertEqual(result['auto_response']['transaction'],'autogroup:1')
        self.assertEqual(result['auto_response']['status'],'error')

    async def test_listener_action_preserves_other_runtime_attributes(self):
        self.hass.states.async_set('sensor.ls_effects_runtime','generation-value',{'generation':'g','targets':{'lamp':1},'auto_syncing':True})
        updates=[]
        async def update(call):
            updates.append(dict(call.data))
            old=self.hass.states.get('sensor.ls_effects_runtime')
            attrs=dict(old.attributes)
            attrs.update(call.data['attributes'])
            self.hass.states.async_set('sensor.ls_effects_runtime',call.data['value'],attrs)
        self.hass.services.async_register('variable','update_sensor',update)
        script=Script(self.hass,cv.SCRIPT_SCHEMA(copy.deepcopy(self.config['actions'])),'state','automation')
        await script.async_run({'trigger':{'id':'groups','payload_json':FIXTURE['bridge_groups']}},Context())
        state=self.hass.states.get('sensor.ls_effects_runtime')
        self.assertEqual(state.state,'generation-value')
        self.assertEqual(state.attributes['generation'],'g')
        self.assertEqual(state.attributes['targets'],{'lamp':1})
        self.assertTrue(state.attributes['auto_syncing'])
        self.assertFalse(updates[0]['replace_attributes'])
        self.assertEqual(len(state.attributes['auto_groups']),len(FIXTURE['bridge_groups']))

if __name__=='__main__':unittest.main(verbosity=2)
