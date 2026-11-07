"""Migration and Night regressions at the new input boundary."""
import copy
import unittest
from input_harness import InputSim, ROOM, CANDLE, NORMAL, KEY, SOURCE

class InputEdgeTests(unittest.TestCase):
    def test_down_keeps_dim_night_but_after_up_the_dimming_floor_holds(self):
        s=InputSim();s.now=s.now.replace(hour=23,minute=35)
        s.click('down')
        self.assertEqual(s.resolved()['room:'+ROOM]['level'],3)
        s.click('up')
        self.assertEqual(s.resolved()['room:'+ROOM]['level'],76.5)
        s.click('down')
        self.assertEqual(s.resolved()['room:'+ROOM]['level'],76.5)

    def test_existing_remote_coordinate_migrates_without_jump_or_losing_candle(self):
        s=InputSim(candle=True)
        stamp=s.now.timestamp()
        claim={'kind':'scale','position':.6,'updated':stamp}
        s.run('ls_commit',data={'op':'set','via':'remote','area':ROOM,'source':SOURCE,'records':[
            {'kind':'channels','key':KEY,'source':SOURCE,'scope':'room','target':ROOM,
             'value':{'position':.6,'channels':{'brightness':claim,'color':copy.deepcopy(claim)}}}]})
        before=s.resolved()
        self.assertEqual(before[CANDLE]['brightness']['effect'],'Candle')
        s.click('up')
        after=s.resolved()
        self.assertEqual(after[CANDLE]['brightness'],before[CANDLE]['brightness'])
        expected=s.pure('effects_scale',day={'brightness':220,'color':{'kelvin':4000}},
                        cosy={'brightness':110,'color':{'kelvin':2200}},position=.7)
        self.assertAlmostEqual(after[NORMAL]['level'],expected['brightness'])
        self.assertEqual(s.attr('sensor.ls_overrides','overrides')[KEY]['kind'],'input')

    def test_candle_selection_keeps_adjusted_underlying_intensity(self):
        s=InputSim();s.click('down');s.click('down')
        level=s.resolved()[NORMAL]['level']
        s.click('left')
        self.assertEqual(s.resolved()[NORMAL]['brightness']['intensity'],level)
        for command in ['up','up','down']:
            s.click(command)
            self.assertEqual(s.resolved()[NORMAL]['brightness']['intensity'],level)

if __name__=='__main__':unittest.main()
