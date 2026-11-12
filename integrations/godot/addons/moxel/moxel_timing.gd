## Frame animation timing, as in Moxel (packages/core/src/animation.ts): a frame is one pose that
## lasts a whole number of ticks, and fps says how long a tick is. Playback asks which frame shows
## at an elapsed time, so a late update skips poses rather than slowing the animation down.
## Shared by MoxelVolume3D and, later, MoxelSprite3D.
class_name MoxelTiming
extends RefCounted


## The whole loop's length in ticks.
static func total_ticks(durations: PackedInt32Array) -> int:
	var total := 0
	for d in durations:
		total += d
	return total


## When frame `index` starts, in ticks from the first frame.
static func frame_start(durations: PackedInt32Array, index: int) -> int:
	var t := 0
	for i in mini(index, durations.size()):
		t += durations[i]
	return t


static func ticks_to_ms(ticks: int, fps: int) -> float:
	return ticks * 1000.0 / fps


## The frame showing `ms` milliseconds after the first frame starts. A frame shows from its start up
## to, not including, the next frame's start. With `loop`, time wraps; without, it stops on the last.
static func frame_at(durations: PackedInt32Array, fps: int, ms: float, loop := true) -> int:
	var total := total_ticks(durations)
	if durations.is_empty() or total <= 0:
		return 0
	# whole ticks, so frame boundaries are exact however the milliseconds round
	var tick := floori(maxf(0.0, ms) * fps / 1000.0 + 1e-6)
	if loop:
		tick = posmod(tick, total)
	elif tick >= total:
		return durations.size() - 1
	for i in durations.size():
		tick -= durations[i]
		if tick < 0:
			return i
	return durations.size() - 1
